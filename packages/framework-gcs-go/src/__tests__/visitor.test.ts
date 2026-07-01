import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { GcsGoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/gcs-go/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new GcsGoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-gcs-go visitor', () => {
  it('emits one ClientSideAPICaller per GCS leaf method', async () => {
    const batch = await extract('storage.go');
    expect(callers(batch).length).toBe(11);
  });

  it('maps methods to HTTP verbs', async () => {
    const batch = await extract('storage.go');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(6);
    expect(byMethod.get('PUT')).toBe(1);
    expect(byMethod.get('DELETE')).toBe(2);
    expect(byMethod.get('PATCH')).toBe(1);
    expect(byMethod.get('POST')).toBe(1);
  });

  it('every caller carries framework="gcs-go"', async () => {
    const batch = await extract('storage.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('gcs-go');
    }
  });

  it('builds gs://<bucket>/<key> URLs for object-scope chains', async () => {
    const batch = await extract('storage.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/logo.png');
    expect(urls).toContain('gs://user-uploads/inbox/new.txt');
    expect(urls).toContain('gs://archive/2026/snapshot.tar');
    expect(urls).toContain('gs://configs/app.json');
    expect(urls).toContain('gs://archive/dest.tar');
    expect(urls).toContain('gs://raw-bucket/raw-key');
  });

  it('builds gs://<bucket>/ URLs for bucket-scope chains', async () => {
    const batch = await extract('storage.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/'); // listFilesInBucket (exact)
    expect(urls).toContain('gs://temp-bucket/');   // deleteBucket (exact)
  });

  it('marks dynamic bucket as dynamic egress and null URL', async () => {
    const batch = await extract('storage.go');
    const dyn = callers(batch).find((c) => c.urlLiteral === null);
    expect(dyn).toBeDefined();
    expect(dyn?.egressConfidence).toBe('dynamic');
  });

  it('marks literal bucket + dynamic object key as dynamic with gs://bucket/ URL', async () => {
    const batch = await extract('storage.go');
    const dynKey = callers(batch).filter(
      (c) => c.urlLiteral === 'gs://static-assets/' && c.egressConfidence === 'dynamic',
    );
    expect(dynKey.length).toBe(1);
  });

  it('stamps isExternal=true and externalHost=<bucket>.storage.googleapis.com', async () => {
    const batch = await extract('storage.go');
    const fetched = callers(batch).find((c) => c.urlLiteral === 'gs://static-assets/logo.png');
    expect(fetched?.isExternal).toBe(true);
    expect(fetched?.externalHost).toBe('static-assets.storage.googleapis.com');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('storage.go');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no cloud.google.com/go/storage import', async () => {
    const batch = await extract('no_imports.go');
    expect(callers(batch)).toEqual([]);
  });
});
