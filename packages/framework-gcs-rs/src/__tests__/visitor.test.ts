import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { RustLanguagePlugin } from '@adorable/lang-rust';
import { GcsRsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/gcs-rs/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new GcsRsPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'gcs-rs-fixture',
    files: ['src/main.rs', 'src/no_imports.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-gcs-rs visitor', () => {
  it('emits one ClientSideAPICaller per GCS verb call', async () => {
    const batch = await extract('src/main.rs');
    // fetch_object, upload_object, delete_object, list_in_bucket,
    // delete_bucket, string_from_form, dynamic_bucket, dynamic_key = 8
    expect(callers(batch).length).toBe(8);
  });

  it('maps verbs to HTTP methods', async () => {
    const batch = await extract('src/main.rs');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(5);
    expect(byMethod.get('PUT')).toBe(1);
    expect(byMethod.get('DELETE')).toBe(2);
  });

  it('every caller carries framework="gcs-rs"', async () => {
    const batch = await extract('src/main.rs');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('gcs-rs');
    }
  });

  it('builds gs://<bucket>/<object> URLs for object-scope ops', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/logo.png');
    expect(urls).toContain('gs://archive/2026/snapshot.tar');
    expect(urls).toContain('gs://configs/app.json'); // String::from form
  });

  it('builds gs://<bucket>/ URLs for bucket-scope ops', async () => {
    const batch = await extract('src/main.rs');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/'); // list_objects (exact)
    expect(urls).toContain('gs://temp-bucket/');   // delete_bucket (exact)
  });

  it('marks dynamic bucket as dynamic egress and null URL', async () => {
    const batch = await extract('src/main.rs');
    const dyn = callers(batch).find((c) => c.urlLiteral === null);
    expect(dyn).toBeDefined();
    expect(dyn?.egressConfidence).toBe('dynamic');
  });

  it('marks literal bucket + dynamic object as dynamic with gs://bucket/ URL', async () => {
    const batch = await extract('src/main.rs');
    const dynKey = callers(batch).filter(
      (c) => c.urlLiteral === 'gs://static-assets/' && c.egressConfidence === 'dynamic',
    );
    // dynamic_key: download_object with bucket="static-assets", object=key
    expect(dynKey.length).toBe(1);
  });

  it('stamps isExternal=true and externalHost=<bucket>.storage.googleapis.com', async () => {
    const batch = await extract('src/main.rs');
    const fetched = callers(batch).find((c) => c.urlLiteral === 'gs://static-assets/logo.png');
    expect(fetched?.isExternal).toBe(true);
    expect(fetched?.externalHost).toBe('static-assets.storage.googleapis.com');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('src/main.rs');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no google-cloud-storage use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(callers(batch)).toEqual([]);
  });
});
