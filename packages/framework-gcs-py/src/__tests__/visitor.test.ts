import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { GcsPyPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/gcs-py/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new GcsPyPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(plugin.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-gcs-py visitor', () => {
  it('emits one ClientSideAPICaller per GCS leaf method', async () => {
    const batch = await extract('storage_ops.py');
    // 13 inline fluent chains in the fixture
    expect(callers(batch).length).toBe(13);
  });

  it('maps methods to HTTP verbs', async () => {
    const batch = await extract('storage_ops.py');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(6);
    expect(byMethod.get('PUT')).toBe(3);
    expect(byMethod.get('DELETE')).toBe(2);
    expect(byMethod.get('PATCH')).toBe(1);
    expect(byMethod.get('POST')).toBe(1);
  });

  it('every caller carries framework="gcs-py"', async () => {
    const batch = await extract('storage_ops.py');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('gcs-py');
    }
  });

  it('builds gs://<bucket>/<key> URLs for blob-scope chains', async () => {
    const batch = await extract('storage_ops.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/logo.png');
    expect(urls).toContain('gs://user-uploads/inbox/new.txt');
    expect(urls).toContain('gs://archive/2026/snapshot.tar');
    expect(urls).toContain('gs://configs/app.json');
    expect(urls).toContain('gs://user-uploads/movie.mp4');
    expect(urls).toContain('gs://archive/composed.tar');
    expect(urls).toContain('gs://public-assets/banner.png');
  });

  it('builds gs://<bucket>/ URLs for bucket-scope chains', async () => {
    const batch = await extract('storage_ops.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/'); // list_blobs (exact)
    expect(urls).toContain('gs://temp-bucket/');   // delete bucket (exact)
  });

  it('marks dynamic bucket as dynamic egress and null URL', async () => {
    const batch = await extract('storage_ops.py');
    const dyn = callers(batch).find((c) => c.urlLiteral === null);
    expect(dyn).toBeDefined();
    expect(dyn?.egressConfidence).toBe('dynamic');
  });

  it('marks literal bucket + dynamic blob key as dynamic with gs://bucket/ URL', async () => {
    const batch = await extract('storage_ops.py');
    const dynKey = callers(batch).filter(
      (c) => c.urlLiteral === 'gs://static-assets/' && c.egressConfidence === 'dynamic',
    );
    expect(dynKey.length).toBe(1);
  });

  it('stamps isExternal=true and externalHost=<bucket>.storage.googleapis.com', async () => {
    const batch = await extract('storage_ops.py');
    const fetched = callers(batch).find((c) => c.urlLiteral === 'gs://static-assets/logo.png');
    expect(fetched?.isExternal).toBe(true);
    expect(fetched?.externalHost).toBe('static-assets.storage.googleapis.com');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('storage_ops.py');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no google-cloud-storage import', async () => {
    const batch = await extract('no_imports.py');
    expect(callers(batch)).toEqual([]);
  });
});
