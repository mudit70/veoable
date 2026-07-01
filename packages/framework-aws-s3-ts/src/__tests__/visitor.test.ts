import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ClientSideAPICaller,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { AwsS3TsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/aws-s3-ts/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new AwsS3TsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-aws-s3-ts visitor', () => {
  it('emits one ClientSideAPICaller per S3 command instantiation', async () => {
    const batch = await extract('storage.ts');
    // fetchObject, headObject, listInbox, uploadObject, copyObject,
    // deleteObject, startMultipart, headBucket, listBuckets,
    // deleteBucket, dynamicBucket, literalBucketOnly = 12
    expect(callers(batch).length).toBe(12);
  });

  it('maps commands to the right HTTP methods', async () => {
    const batch = await extract('storage.ts');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    // GET: fetchObject, listInbox, listBuckets, dynamicBucket,
    //   literalBucketOnly = 5
    // HEAD: headObject, headBucket = 2
    // PUT: uploadObject, copyObject = 2
    // DELETE: deleteObject, deleteBucket = 2
    // POST: startMultipart = 1
    expect(byMethod.get('GET')).toBe(5);
    expect(byMethod.get('HEAD')).toBe(2);
    expect(byMethod.get('PUT')).toBe(2);
    expect(byMethod.get('DELETE')).toBe(2);
    expect(byMethod.get('POST')).toBe(1);
  });

  it('every caller carries framework="aws-s3-ts"', async () => {
    const batch = await extract('storage.ts');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('aws-s3-ts');
    }
  });

  it('emits s3://<bucket>/<key> for literal Bucket + Key', async () => {
    const batch = await extract('storage.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('s3://static-assets/logo.png');
    expect(urls).toContain('s3://user-uploads/inbox/new.txt');
    expect(urls).toContain('s3://archive/2026/snapshot.tar');
    expect(urls).toContain('s3://user-uploads/large/movie.mp4');
  });

  it('emits bucket-only URL when only Bucket resolves', async () => {
    const batch = await extract('storage.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('s3://static-assets/'); // headBucket
    expect(urls).toContain('s3://known-bucket/'); // literalBucketOnly
  });

  it('classifies dynamic Bucket as dynamic egress', async () => {
    const batch = await extract('storage.ts');
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    // dynamicBucket → dynamic; listBuckets → no Bucket → dynamic
    expect(dyn.length).toBeGreaterThanOrEqual(2);
  });

  it('stamps isExternal=true and externalHost=<bucket>.s3.amazonaws.com', async () => {
    const batch = await extract('storage.ts');
    const fetch = callers(batch).find((c) => c.urlLiteral === 's3://static-assets/logo.png');
    expect(fetch?.isExternal).toBe(true);
    expect(fetch?.externalHost).toBe('static-assets.s3.amazonaws.com');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('storage.ts');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no @aws-sdk/client-s3 import', async () => {
    const batch = await extract('no_imports.ts');
    expect(callers(batch)).toEqual([]);
  });
});

describe('framework-aws-s3-ts visitor — non-S3 services', () => {
  it('DynamoDB: extracts dynamodb://<table>/ and maps verbs', async () => {
    const batch = await extract('services.ts');
    const dynamo = callers(batch).filter((c) => c.framework === 'aws-dynamodb-ts');
    // getUser, putUser, queryOrders, scanAudit, updateProfile,
    // deleteSession, createTable, dynamicTable = 8
    expect(dynamo.length).toBe(8);
    const urls = dynamo.map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://users/');
    expect(urls).toContain('dynamodb://orders/');
    expect(urls).toContain('dynamodb://audit-log/');
    expect(urls).toContain('dynamodb://sessions/');
    expect(urls).toContain('dynamodb://new-table/');
    expect(urls).toContain(null);
    const byMethod = new Map<string, number>();
    for (const c of dynamo) byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    expect(byMethod.get('GET')).toBe(4);    // getUser, queryOrders, scanAudit, dynamicTable
    expect(byMethod.get('PUT')).toBe(1);    // putUser
    expect(byMethod.get('PATCH')).toBe(1);  // updateProfile
    expect(byMethod.get('DELETE')).toBe(1); // deleteSession
    expect(byMethod.get('POST')).toBe(1);   // createTable
  });

  it('SQS: extracts sqs:<queue-name> from QueueUrl tail and stamps JOB', async () => {
    const batch = await extract('services.ts');
    const sqs = callers(batch).filter((c) => c.framework === 'aws-sqs-ts');
    expect(sqs.length).toBe(3);
    const urls = sqs.map((c) => c.urlLiteral);
    expect(urls.filter((u) => u === 'sqs:order-events').length).toBe(2);
    expect(urls).toContain(null);
    for (const c of sqs) expect(c.httpMethod).toBe('JOB');
  });

  it('SNS: extracts sns:<topic-name> from TopicArn tail and stamps JOB', async () => {
    const batch = await extract('services.ts');
    const sns = callers(batch).filter((c) => c.framework === 'aws-sns-ts');
    expect(sns.length).toBe(2);
    const urls = sns.map((c) => c.urlLiteral);
    expect(urls).toContain('sns:critical-alerts');
    expect(urls).toContain(null);
    for (const c of sns) expect(c.httpMethod).toBe('JOB');
  });

  it('Lambda: extracts lambda:<FunctionName> and stamps POST / JOB', async () => {
    const batch = await extract('services.ts');
    const lam = callers(batch).filter((c) => c.framework === 'aws-lambda-ts');
    expect(lam.length).toBe(3);
    const urls = lam.map((c) => c.urlLiteral);
    expect(urls).toContain('lambda:process-order');
    expect(urls).toContain('lambda:async-worker');
    expect(urls).toContain(null);
    const sync = lam.find((c) => c.urlLiteral === 'lambda:process-order');
    expect(sync?.httpMethod).toBe('POST');
    const asyncCall = lam.find((c) => c.urlLiteral === 'lambda:async-worker');
    expect(asyncCall?.httpMethod).toBe('JOB');
  });

  it('stamps per-service externalHost', async () => {
    const batch = await extract('services.ts');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    const hosts = new Map<string, Set<string>>();
    for (const c of exact) {
      const set = hosts.get(c.framework ?? '') ?? new Set<string>();
      if (c.externalHost) set.add(c.externalHost);
      hosts.set(c.framework ?? '', set);
    }
    expect(hosts.get('aws-dynamodb-ts')).toEqual(new Set(['dynamodb.amazonaws.com']));
    expect(hosts.get('aws-sqs-ts')).toEqual(new Set(['sqs.amazonaws.com']));
    expect(hosts.get('aws-sns-ts')).toEqual(new Set(['sns.amazonaws.com']));
    expect(hosts.get('aws-lambda-ts')).toEqual(new Set(['lambda.amazonaws.com']));
  });
});
