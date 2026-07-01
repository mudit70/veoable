import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { GoLanguagePlugin } from '@veoable/lang-go';
import { AwsgoS3Plugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/awsgo-s3/basic');

async function extract(file: string): Promise<NodeBatch> {
  const awsgo = new AwsgoS3Plugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(awsgo.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-awsgo-s3 visitor', () => {
  it('emits one ClientSideAPICaller per recognized S3 method', async () => {
    const batch = await extract('storage.go');
    // GetObject, HeadObject, ListObjectsV2, PutObject, CopyObject,
    // DeleteObject, DeleteObjects, CreateMultipartUpload,
    // DynamicBucket.GetObject, StorageService.Fetch.GetObject = 10
    // kvStore.GetObject negative: not detected (receiver `k` no
    // match) — though kvStore is also outside the import-aware
    // gate's reach.
    expect(callers(batch).length).toBe(10);
  });

  it('marks every caller with framework="awsgo-s3"', async () => {
    const batch = await extract('storage.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('awsgo-s3');
    }
  });

  it('extracts s3://bucket/key URLs from Input struct fields', async () => {
    const batch = await extract('storage.go');
    const urls = callers(batch).map((c) => c.urlLiteral).sort();
    expect(urls).toContain('s3://avatars/users/static.png');
    expect(urls).toContain('s3://avatars/ready.png');
    expect(urls).toContain('s3://avatars/users/1.png');
    expect(urls).toContain('s3://avatars-archive/backup.png');
    expect(urls).toContain('s3://audit-logs/');
    expect(urls).toContain('s3://uploads/big.bin');
  });

  it('classifies HTTP methods correctly (GET/HEAD/PUT/POST/DELETE)', async () => {
    const batch = await extract('storage.go');
    const methods = new Set(callers(batch).map((c) => c.httpMethod));
    expect(methods.has('GET')).toBe(true);
    expect(methods.has('HEAD')).toBe(true);
    expect(methods.has('PUT')).toBe(true);
    expect(methods.has('POST')).toBe(true);
    expect(methods.has('DELETE')).toBe(true);
  });

  it('marks fully dynamic calls (non-literal Bucket) as dynamic', async () => {
    const batch = await extract('storage.go');
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    expect(dyn.length).toBe(1);
    expect(dyn[0].urlLiteral).toBeNull();
  });

  it('resolves selector receiver `s.s3Client.GetObject(...)` inside a struct method', async () => {
    const batch = await extract('storage.go');
    const svc = callers(batch).find((c) => c.urlLiteral === 's3://service-bucket/data.json');
    expect(svc).toBeTruthy();
    expect(svc!.httpMethod).toBe('GET');
  });

  it('stamps isExternal + externalHost as <bucket>.s3.amazonaws.com', async () => {
    const batch = await extract('storage.go');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exact.length).toBeGreaterThan(0);
    for (const c of exact) {
      expect(c.isExternal).toBe(true);
      expect(c.externalHost).toMatch(/\.s3\.amazonaws\.com$/);
    }
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extract('storage.go');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('does NOT emit for kvStore.GetObject on a non-S3 receiver', async () => {
    const batch = await extract('storage.go');
    // kvStore.GetObject — receiver `k` doesn't contain s3/bucket/
    // client substrings → rejected by RECEIVER_RE.
    const urls = callers(batch).map((c) => c.urlLiteral ?? '<dynamic>');
    expect(urls).not.toContain('s3://foo/');
  });
});

describe('framework-awsgo visitor — non-S3 services', () => {
  it('DynamoDB: extracts dynamodb://<TableName>/ and maps verbs', async () => {
    const batch = await extract('services.go');
    const dynamo = callers(batch).filter((c) => c.framework === 'awsgo-dynamodb');
    // getUser, putUser, queryOrders, deleteSession, updateProfile,
    // dynamicTable = 6
    expect(dynamo.length).toBe(6);
    const urls = dynamo.map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://users/');
    expect(urls).toContain('dynamodb://orders/');
    expect(urls).toContain('dynamodb://sessions/');
    expect(urls).toContain(null); // dynamicTable
    const byMethod = new Map<string, number>();
    for (const c of dynamo) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(3); // getUser, queryOrders, dynamicTable
    expect(byMethod.get('PUT')).toBe(1); // putUser
    expect(byMethod.get('DELETE')).toBe(1); // deleteSession
    expect(byMethod.get('PATCH')).toBe(1); // updateProfile
  });

  it('SQS: extracts sqs:<queue-name> from QueueUrl tail and stamps JOB', async () => {
    const batch = await extract('services.go');
    const sqs = callers(batch).filter((c) => c.framework === 'awsgo-sqs');
    expect(sqs.length).toBe(3);
    const urls = sqs.map((c) => c.urlLiteral);
    expect(urls.filter((u) => u === 'sqs:order-events').length).toBe(2);
    expect(urls).toContain(null);
    for (const c of sqs) expect(c.httpMethod).toBe('JOB');
  });

  it('SNS: extracts sns:<topic-name> from TopicArn tail and stamps JOB', async () => {
    const batch = await extract('services.go');
    const sns = callers(batch).filter((c) => c.framework === 'awsgo-sns');
    expect(sns.length).toBe(2);
    const urls = sns.map((c) => c.urlLiteral);
    expect(urls).toContain('sns:critical-alerts');
    expect(urls).toContain(null);
    for (const c of sns) expect(c.httpMethod).toBe('JOB');
  });

  it('Lambda: extracts lambda:<FunctionName> and stamps POST', async () => {
    const batch = await extract('services.go');
    const lam = callers(batch).filter((c) => c.framework === 'awsgo-lambda');
    expect(lam.length).toBe(2);
    const urls = lam.map((c) => c.urlLiteral);
    expect(urls).toContain('lambda:process-order');
    expect(urls).toContain(null);
    for (const c of lam) expect(c.httpMethod).toBe('POST');
  });

  it('stamps per-service externalHost', async () => {
    const batch = await extract('services.go');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    const hosts = new Map<string, Set<string>>();
    for (const c of exact) {
      const set = hosts.get(c.framework ?? '') ?? new Set<string>();
      if (c.externalHost) set.add(c.externalHost);
      hosts.set(c.framework ?? '', set);
    }
    expect(hosts.get('awsgo-dynamodb')).toEqual(new Set(['dynamodb.amazonaws.com']));
    expect(hosts.get('awsgo-sqs')).toEqual(new Set(['sqs.amazonaws.com']));
    expect(hosts.get('awsgo-sns')).toEqual(new Set(['sns.amazonaws.com']));
    expect(hosts.get('awsgo-lambda')).toEqual(new Set(['lambda.amazonaws.com']));
  });

  it('rejects collisions: redisClient.Publish() and dbClient.Invoke() do not fire', async () => {
    const batch = await extract('services.go');
    // Fixture has 6 DynamoDB + 3 SQS + 2 SNS + 2 Lambda = 13 legit.
    // Plus 2 collision guards (redisClient.Publish, dbClient.Invoke)
    // that must NOT fire. Total = 13.
    expect(callers(batch).length).toBe(13);
  });
});
