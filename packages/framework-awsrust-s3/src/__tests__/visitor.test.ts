import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ClientSideAPICaller,
  SchemaNode,
} from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { AwsrustS3Plugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/awsrust-s3/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new AwsrustS3Plugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'awsrust-s3-fixture',
    files: ['src/main.rs', 'src/no_imports.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-awsrust-s3 visitor', () => {
  it('emits one ClientSideAPICaller per S3 builder call', async () => {
    const batch = await extract('src/main.rs');
    // Verb calls in main.rs:
    //   fetch_object, head_object, list_v2, put_object,
    //   put_with_string_wrappers, copy_object, delete_object,
    //   delete_bucket, list_buckets, dynamic_key, dynamic_key_two,
    //   multipart (create_multipart_upload), head_bucket,
    //   two_calls_same_fn (get_object + delete_object), set_form
    // = 16
    expect(callers(batch).length).toBe(16);
  });

  it('maps verbs to correct HTTP methods', async () => {
    const batch = await extract('src/main.rs');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod, (byMethod.get(c.httpMethod) ?? 0) + 1);
    }
    // GET: fetch_object, list_v2, list_buckets, dynamic_key,
    //   dynamic_key_two, two_calls_same_fn(get_object) = 6
    // HEAD: head_object, head_bucket, set_form(head_object) = 3
    // PUT: put_object, put_with_string_wrappers, copy_object = 3
    // DELETE: delete_object, delete_bucket,
    //   two_calls_same_fn(delete_object) = 3
    // POST: create_multipart_upload = 1
    expect(byMethod.get('GET')).toBe(6);
    expect(byMethod.get('HEAD')).toBe(3);
    expect(byMethod.get('PUT')).toBe(3);
    expect(byMethod.get('DELETE')).toBe(3);
    expect(byMethod.get('POST')).toBe(1);
  });

  it('resolves two S3 calls in the same function to their own bucket+key', async () => {
    // Regression: a naive walk-up to the enclosing function would
    // grab the FIRST .bucket(...) literal in the function body and
    // assign it to BOTH calls. The chain walker should stay inside
    // each builder.
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('s3://alpha-bucket/alpha.json');
    expect(urls).toContain('s3://beta-bucket/beta.json');
  });

  it('handles the `.set_bucket(Some("x"))` / `.set_key(Some("y"))` setter form', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('s3://gamma-bucket/gamma.txt');
  });

  it('marks every caller framework="awsrust-s3"', async () => {
    const batch = await extract('src/main.rs');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('awsrust-s3');
    }
  });

  it('extracts s3://<bucket>/<key> for literal bucket+key chains', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('s3://static-assets/logo.png');
    expect(urls).toContain('s3://user-uploads/inbox/new.txt');
    expect(urls).toContain('s3://archive/2026/snapshot.tar');
    expect(urls).toContain('s3://user-uploads/large/movie.mp4');
  });

  it('handles `.to_string()` / `.to_owned()` wrappers around literals', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('s3://user-uploads/rendered/index.html');
  });

  it('emits bucket-only URL for verbs without a key (head_bucket / list_buckets)', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    // head_bucket → s3://static-assets/
    expect(urls).toContain('s3://static-assets/');
    // list_buckets has no bucket arg at all → dynamic (null)
    const listAll = callers(batch).find((c) => c.evidence?.snippet?.includes('list_buckets'));
    expect(listAll?.urlLiteral).toBeNull();
    expect(listAll?.egressConfidence).toBe('dynamic');
  });

  it('classifies dynamic-bucket or dynamic-key as dynamic egress', async () => {
    const batch = await extract('src/main.rs');
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    // dynamic_key (both bucket and key are vars) → dynamic
    // dynamic_key_two (literal bucket, dynamic key) → still
    //   only emits "s3://known-bucket/" (bucket only, exact) → not
    //   counted here; just dynamic_key + list_buckets.
    expect(dyn.length).toBeGreaterThanOrEqual(2);
  });

  it('stamps isExternal=true and externalHost=<bucket>.s3.amazonaws.com', async () => {
    const batch = await extract('src/main.rs');
    const fetch = callers(batch).find((c) => c.urlLiteral === 's3://static-assets/logo.png');
    expect(fetch?.isExternal).toBe(true);
    expect(fetch?.externalHost).toBe('static-assets.s3.amazonaws.com');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('src/main.rs');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no aws_sdk_s3 use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(callers(batch)).toEqual([]);
  });
});

describe('framework-awsrust visitor — non-S3 services', () => {
  it('DynamoDB: extracts dynamodb://<table>/ from .table_name(...) builder', async () => {
    const batch = await extract('src/services.rs');
    const dynamo = callers(batch).filter((c) => c.framework === 'awsrust-dynamodb');
    expect(dynamo.length).toBe(6);
    const urls = dynamo.map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://users/');
    expect(urls).toContain('dynamodb://orders/');
    expect(urls).toContain('dynamodb://sessions/');
    expect(urls).toContain(null); // dynamic_table
    const byMethod = new Map<string, number>();
    for (const c of dynamo) byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    expect(byMethod.get('GET')).toBe(3);    // get_user, query_orders, dynamic_table
    expect(byMethod.get('PUT')).toBe(1);    // put_user
    expect(byMethod.get('DELETE')).toBe(1); // delete_session
    expect(byMethod.get('PATCH')).toBe(1);  // update_profile
  });

  it('SQS: extracts sqs:<queue-name> from .queue_url(...) tail and stamps JOB', async () => {
    const batch = await extract('src/services.rs');
    const sqs = callers(batch).filter((c) => c.framework === 'awsrust-sqs');
    expect(sqs.length).toBe(3);
    const urls = sqs.map((c) => c.urlLiteral);
    expect(urls.filter((u) => u === 'sqs:order-events').length).toBe(2);
    expect(urls).toContain(null);
    for (const c of sqs) expect(c.httpMethod).toBe('JOB');
  });

  it('SNS: extracts sns:<topic-name> from .topic_arn(...) tail and stamps JOB', async () => {
    const batch = await extract('src/services.rs');
    const sns = callers(batch).filter((c) => c.framework === 'awsrust-sns');
    expect(sns.length).toBe(2);
    const urls = sns.map((c) => c.urlLiteral);
    expect(urls).toContain('sns:critical-alerts');
    expect(urls).toContain(null);
    for (const c of sns) expect(c.httpMethod).toBe('JOB');
  });

  it('Lambda: extracts lambda:<function-name> from .function_name(...) and stamps POST', async () => {
    const batch = await extract('src/services.rs');
    const lam = callers(batch).filter((c) => c.framework === 'awsrust-lambda');
    expect(lam.length).toBe(2);
    const urls = lam.map((c) => c.urlLiteral);
    expect(urls).toContain('lambda:process-order');
    expect(urls).toContain(null);
    for (const c of lam) expect(c.httpMethod).toBe('POST');
  });

  it('stamps per-service externalHost', async () => {
    const batch = await extract('src/services.rs');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    const hosts = new Map<string, Set<string>>();
    for (const c of exact) {
      const set = hosts.get(c.framework ?? '') ?? new Set<string>();
      if (c.externalHost) set.add(c.externalHost);
      hosts.set(c.framework ?? '', set);
    }
    expect(hosts.get('awsrust-dynamodb')).toEqual(new Set(['dynamodb.amazonaws.com']));
    expect(hosts.get('awsrust-sqs')).toEqual(new Set(['sqs.amazonaws.com']));
    expect(hosts.get('awsrust-sns')).toEqual(new Set(['sns.amazonaws.com']));
    expect(hosts.get('awsrust-lambda')).toEqual(new Set(['lambda.amazonaws.com']));
  });
});

describe('struct-field identifier-arg resolution (#523 item 1)', () => {
  // Re-run extract() to include the new fixture files in the
  // visitor's project-load pass. The harness above already supports
  // arbitrary files because plugin.onProjectLoaded reads from
  // FIXTURE_ROOT, not the file list passed in `files`.

  it('resolves &state.<field> via the env-with-unwrap_or_else fallback literal', async () => {
    const batch = await extract('src/handlers.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://Orders/');
  });

  it('resolves &state.<field> for SQS queue_url via the env fallback URL literal', async () => {
    const batch = await extract('src/handlers.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('sqs:orders-incoming');
  });

  it('resolves state.<field>.clone() (no leading &, with .clone() suffix) via unwrap_or fallback', async () => {
    const batch = await extract('src/handlers.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://Sessions/');
  });

  it('resolves bare-literal default fields (no env wrapping)', async () => {
    const batch = await extract('src/handlers.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('dynamodb://uploads/');
  });

  it('every resolved struct-field caller still gets exact confidence', async () => {
    const batch = await extract('src/handlers.rs');
    const dynamic = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    // All five handlers (query/cancel/enqueue/read_session/upload)
    // should resolve via the struct-field map.
    expect(dynamic).toHaveLength(0);
  });

  it('resolves `let`-bound locals via the env-fallback pattern', async () => {
    const batch = await extract('src/let_binding.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    // Worker-style: `let notif_queue_url = env::var(...).unwrap_or_else(|_| "...".into())`
    // then `sqs.send_message().queue_url(&notif_queue_url)` resolves
    // via the let-binding path of the project-load resolver.
    expect(urls).toContain('sqs:notifications');
  });

  it('leaves unresolvable args (function call return) as dynamic — no false positive', async () => {
    const batch = await extract('src/unresolvable.rs');
    const cs = callers(batch);
    // Both call sites in the fixture pass a function-call-result or a
    // conditional to `.table_name(...)`. Neither matches the
    // struct-field map; both must land as dynamic.
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      expect(c.urlLiteral, `expected dynamic, got '${c.urlLiteral}'`).toBeNull();
      expect(c.egressConfidence).toBe('dynamic');
    }
  });

  it('documents last-write-wins on name collisions across functions', async () => {
    const batch = await extract('src/collision.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    // The fixture has TWO `let table = "..."` bindings in different
    // functions, both reaching a `.table_name(table)` call. The map
    // is keyed by name only, so last-write-wins: both call sites
    // resolve to the same literal (whichever the regex visited
    // second). This pins the documented limitation rather than the
    // exact value, so a reordering of pattern scans doesn't break
    // the test.
    const resolved = urls.filter((u) => u && u.startsWith('dynamodb://'));
    expect(resolved.length).toBe(2);
    // Both calls produced the SAME url — collision collapsed to one.
    const unique = new Set(resolved);
    expect(unique.size).toBe(1);
  });
});
