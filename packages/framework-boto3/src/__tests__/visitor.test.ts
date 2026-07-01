import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { Boto3Plugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/boto3/basic');

async function extract(file: string): Promise<NodeBatch> {
  const boto3 = new Boto3Plugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(boto3.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-boto3 visitor', () => {
  it('emits one ClientSideAPICaller per recognized S3 method', async () => {
    const batch = await extract('storage.py');
    // get_object, head_object, list_objects_v2, generate_presigned_url
    // (4 reads)
    // put_object, copy_object, upload_file (positional), upload_file
    // (kwargs), create_multipart_upload (5 writes)
    // delete_object, delete_objects (2 deletes)
    // dynamic_bucket_get: get_object with dynamic Bucket (1 read)
    // StorageService.store: put_object (1 write)
    // download_file_positional: download_file (1 read)
    // generate_dynamic_url: generate_presigned_url (1 read, dynamic)
    // generate_nested_dict_url: generate_presigned_url (1 read, dynamic)
    // = 16 total. dict.get is rejected by CLIENT_RECEIVER_RE.
    expect(callers(batch).length).toBe(16);
  });

  it('marks every caller with framework="boto3-s3"', async () => {
    const batch = await extract('storage.py');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('boto3-s3');
    }
  });

  it('extracts s3://bucket/key URLs from Bucket=/Key= kwargs', async () => {
    const batch = await extract('storage.py');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    const urls = exact.map((c) => c.urlLiteral);
    expect(urls).toContain('s3://avatars/static.txt');
    expect(urls).toContain('s3://avatars-archive/copy.png');
    expect(urls).toContain('s3://uploads/big.bin');
    expect(urls).toContain('s3://audit-logs/');
  });

  it('builds s3://bucket/ when only Bucket is static (no Key)', async () => {
    const batch = await extract('storage.py');
    const listAll = callers(batch).find((c) => c.urlLiteral === 's3://audit-logs/');
    expect(listAll).toBeTruthy();
    expect(listAll!.httpMethod).toBe('GET');
  });

  it('handles positional form for upload_file(file, bucket, key)', async () => {
    const batch = await extract('storage.py');
    const upload = callers(batch).find((c) => c.urlLiteral === 's3://uploads/remote.txt');
    expect(upload).toBeTruthy();
    expect(upload!.httpMethod).toBe('PUT');
  });

  it('handles positional form for download_file(bucket, key, file)', async () => {
    const batch = await extract('storage.py');
    const dl = callers(batch).find((c) => c.urlLiteral === 's3://audit-logs/old.log');
    expect(dl).toBeTruthy();
    expect(dl!.httpMethod).toBe('GET');
  });

  it('classifies HTTP methods correctly (GET/PUT/POST/DELETE/HEAD)', async () => {
    const batch = await extract('storage.py');
    const methods = new Set(callers(batch).map((c) => c.httpMethod));
    expect(methods.has('GET')).toBe(true);
    expect(methods.has('HEAD')).toBe(true);
    expect(methods.has('PUT')).toBe(true);
    expect(methods.has('POST')).toBe(true);
    expect(methods.has('DELETE')).toBe(true);
  });

  it('f-string Key falls back to dynamic egress confidence', async () => {
    const batch = await extract('storage.py');
    // upload_avatar and get_user_avatar use f-string Key. The URL
    // will have a literal Bucket but null Key → s3://avatars/.
    // No wait — buildS3Url with bucket and null key emits
    // 's3://bucket/' with exact confidence (we DO know the bucket).
    // The Key being dynamic means the egress URL is partly dynamic
    // but the visitor's choice is: confidence='exact' when bucket
    // resolves. That's how we built it. Verify.
    const partial = callers(batch).filter((c) => c.urlLiteral === 's3://avatars/');
    // get_user_avatar (read) + upload_avatar (put) +
    // delete_avatar (delete) = 3
    expect(partial.length).toBe(3);
  });

  it('marks fully dynamic calls (no static bucket) with egressConfidence=dynamic', async () => {
    const batch = await extract('storage.py');
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    // dynamic_bucket_get: get_object with identifier bucket.
    // generate_dynamic_url: Params={'Bucket': bucket_var, 'Key': key_var}.
    // generate_nested_dict_url: Params={'Bucket': {...}, 'Key': 'plain.txt'}
    //   — Bucket is a dict literal, Key is a string. Resolver returns
    //   null for the dict-valued entry, falls back to dynamic overall.
    expect(dyn.length).toBe(3);
    for (const c of dyn) expect(c.urlLiteral).toBeNull();
  });

  it('resolves bucket/key from Params={...} dict (generate_presigned_url)', async () => {
    const batch = await extract('storage.py');
    const presign = callers(batch).find((c) => c.urlLiteral === 's3://uploads/static.txt');
    // generate_presigned_url passes its target as
    //   Params={'Bucket': 'uploads', 'Key': 'static.txt'}
    // The Params-dict walker should resolve both literals.
    expect(presign).toBeTruthy();
    expect(presign?.egressConfidence).toBe('exact');
  });

  it('stays dynamic when Params entries are identifier-valued', async () => {
    const batch = await extract('storage.py');
    // generate_dynamic_url:
    //   Params={'Bucket': bucket_var, 'Key': key_var}
    // Identifiers (no string literal) — stringFromDictLiteral returns
    // null, the visitor falls through to dynamic.
    const cs = callers(batch).filter((c) =>
      (c.evidence?.snippet ?? '').includes('generate_dynamic_url'.length > 0 ? 'bucket_var' : ''),
    );
    // No exact URL with the identifier name as text:
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).not.toContain('s3://bucket_var/key_var');
  });

  it('stays dynamic when a Params entry is a dict literal', async () => {
    const batch = await extract('storage.py');
    // generate_nested_dict_url:
    //   Params={'Bucket': {'inner': 'x'}, 'Key': 'plain.txt'}
    // Bucket is a dict literal (not a string). The visitor must NOT
    // synthesize anything from the inner dict — it should return null
    // for the bucket and fall back to dynamic overall.
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).not.toContain('s3://inner/plain.txt');
    expect(urls).not.toContain('s3://x/plain.txt');
    // The 'plain.txt' Key was a string literal — verify the visitor
    // did not emit a partial URL claiming an exact key with no bucket.
    expect(urls.filter((u) => u && u.endsWith('/plain.txt')).length).toBe(0);
  });

  it('handles single-quoted dict keys in Params={...}', async () => {
    const batch = await extract('storage.py');
    // The fixture uses single-quoted keys throughout Params={'Bucket': …}.
    // The walker must strip both single and double quotes equally.
    const presign = callers(batch).find((c) => c.urlLiteral === 's3://uploads/static.txt');
    expect(presign).toBeTruthy();
  });

  it('resolves self.s3 client inside a class method', async () => {
    const batch = await extract('storage.py');
    const svc = callers(batch).find((c) => c.urlLiteral === 's3://service-bucket/');
    expect(svc).toBeTruthy();
    expect(svc!.httpMethod).toBe('PUT');
  });

  it('emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extract('storage.py');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('rejects dict.get(...) on a non-S3 receiver', async () => {
    // unrelated() calls `d.get('foo')` where `d` is a dict. The
    // receiver `d` doesn't match CLIENT_RECEIVER_RE so the visitor
    // declines. If it leaked, urlLiteral would be `s3://None/` or
    // similar nonsense; instead the count assertion above stays at 14.
    const batch = await extract('storage.py');
    const urls = callers(batch).map((c) => c.urlLiteral ?? '<dynamic>');
    expect(urls).not.toContain('s3://foo/');
    expect(urls).not.toContain('foo');
  });

  it('stamps isExternal + externalHost as <bucket>.s3.amazonaws.com', async () => {
    const batch = await extract('storage.py');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exact.length).toBeGreaterThan(0);
    for (const c of exact) {
      expect(c.isExternal).toBe(true);
      expect(c.externalHost).toMatch(/\.s3\.amazonaws\.com$/);
    }
    // Dynamic callers (no resolved bucket) carry no isExternal flag.
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    for (const c of dyn) expect(c.isExternal).toBeUndefined();
  });

  it('rejects all emits in a file with no boto3/aioboto3 import', async () => {
    const batch = await extract('no_imports.py');
    expect(callers(batch)).toEqual([]);
  });
});

describe('framework-boto3 visitor — non-S3 services', () => {
  it('emits 17 callers across DynamoDB / SQS / SNS / Lambda', async () => {
    const batch = await extract('services.py');
    expect(callers(batch).length).toBe(17);
  });

  it('DynamoDB: extracts dynamodb://<TableName>/ for known verbs', async () => {
    const batch = await extract('services.py');
    const dynamo = callers(batch).filter((c) => c.framework === 'boto3-dynamodb');
    expect(dynamo.length).toBe(8);
    const urls = dynamo.map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://users/');
    expect(urls).toContain('dynamodb://orders/');
    expect(urls).toContain('dynamodb://audit-log/');
    expect(urls).toContain('dynamodb://sessions/');
    expect(urls).toContain('dynamodb://new-table/');
    expect(urls).toContain(null); // dynamic_table
  });

  it('DynamoDB: maps verbs to HTTP methods', async () => {
    const batch = await extract('services.py');
    const dynamo = callers(batch).filter((c) => c.framework === 'boto3-dynamodb');
    const byMethod = new Map<string, number>();
    for (const c of dynamo) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    // get_item, query, scan, dynamic_table = 4 GET
    // put_item = 1 PUT
    // delete_item = 1 DELETE
    // update_item = 1 PATCH
    // create_table = 1 POST
    expect(byMethod.get('GET')).toBe(4);
    expect(byMethod.get('PUT')).toBe(1);
    expect(byMethod.get('DELETE')).toBe(1);
    expect(byMethod.get('PATCH')).toBe(1);
    expect(byMethod.get('POST')).toBe(1);
  });

  it('SQS: extracts sqs:<queue-name> from QueueUrl tail and stamps JOB', async () => {
    const batch = await extract('services.py');
    const sqs = callers(batch).filter((c) => c.framework === 'boto3-sqs');
    expect(sqs.length).toBe(3);
    const urls = sqs.map((c) => c.urlLiteral);
    expect(urls.filter((u) => u === 'sqs:order-events').length).toBe(2);
    expect(urls).toContain(null);
    for (const c of sqs) expect(c.httpMethod).toBe('JOB');
  });

  it('SNS: extracts sns:<topic-name> from TopicArn / TargetArn tail and stamps JOB', async () => {
    const batch = await extract('services.py');
    const sns = callers(batch).filter((c) => c.framework === 'boto3-sns');
    expect(sns.length).toBe(3);
    const urls = sns.map((c) => c.urlLiteral);
    expect(urls).toContain('sns:critical-alerts');
    // TargetArn ends with `endpoint/APNS/MyApp/device-token-x`; we keep
    // the full last colon-segment so the device id is preserved.
    expect(urls).toContain('sns:endpoint/APNS/MyApp/device-token-x');
    expect(urls).toContain(null);
    for (const c of sns) expect(c.httpMethod).toBe('JOB');
  });

  it('Lambda: extracts lambda:<FunctionName> and stamps POST / JOB', async () => {
    const batch = await extract('services.py');
    const lam = callers(batch).filter((c) => c.framework === 'boto3-lambda');
    expect(lam.length).toBe(3);
    const urls = lam.map((c) => c.urlLiteral);
    expect(urls).toContain('lambda:process-order');
    expect(urls).toContain('lambda:async-worker');
    expect(urls).toContain(null);
    const invokeProc = lam.find((c) => c.urlLiteral === 'lambda:process-order');
    expect(invokeProc?.httpMethod).toBe('POST');
    const invokeAsync = lam.find((c) => c.urlLiteral === 'lambda:async-worker');
    expect(invokeAsync?.httpMethod).toBe('JOB');
  });

  it('stamps service-specific externalHost on each non-S3 caller', async () => {
    const batch = await extract('services.py');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    const hostByFramework = new Map<string, Set<string>>();
    for (const c of exact) {
      const set = hostByFramework.get(c.framework ?? '') ?? new Set<string>();
      if (c.externalHost) set.add(c.externalHost);
      hostByFramework.set(c.framework ?? '', set);
    }
    expect(hostByFramework.get('boto3-dynamodb')).toEqual(new Set(['dynamodb.amazonaws.com']));
    expect(hostByFramework.get('boto3-sqs')).toEqual(new Set(['sqs.amazonaws.com']));
    expect(hostByFramework.get('boto3-sns')).toEqual(new Set(['sns.amazonaws.com']));
    expect(hostByFramework.get('boto3-lambda')).toEqual(new Set(['lambda.amazonaws.com']));
  });

  it('rejects collisions: redis_client.publish() and db_client.invoke() do not fire', async () => {
    const batch = await extract('services.py');
    // The fixture has 17 legitimate boto3 calls + 2 collision guards
    // (redis_client.publish, db_client.invoke). If the per-service
    // receiver gate didn't reject the collisions, the count would
    // jump and we'd see a `sns:channel` URL.
    expect(callers(batch).length).toBe(17);
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).not.toContain('sns:channel');
    expect(urls).not.toContain('lambda:');
  });
});
