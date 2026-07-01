import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { GcsTsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/gcs-ts/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new GcsTsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-gcs-ts visitor', () => {
  it('emits one ClientSideAPICaller per GCS leaf method', async () => {
    const batch = await extract('storage.ts');
    // 13 fluent chains in the fixture
    expect(callers(batch).length).toBe(13);
  });

  it('maps methods to HTTP verbs', async () => {
    const batch = await extract('storage.ts');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(7);
    expect(byMethod.get('PUT')).toBe(2);
    expect(byMethod.get('DELETE')).toBe(2);
    expect(byMethod.get('POST')).toBe(1);
    expect(byMethod.get('PATCH')).toBe(1);
  });

  it('every caller carries framework="gcs-ts"', async () => {
    const batch = await extract('storage.ts');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('gcs-ts');
    }
  });

  it('builds gs://<bucket>/<key> URLs for file-scope chains', async () => {
    const batch = await extract('storage.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://static-assets/logo.png');
    expect(urls).toContain('gs://user-uploads/inbox/new.txt');
    expect(urls).toContain('gs://archive/2026/snapshot.tar');
    expect(urls).toContain('gs://archive/old.tar');
    expect(urls).toContain('gs://configs/app.json');
  });

  it('builds gs://<bucket>/ URLs for bucket-scope chains', async () => {
    const batch = await extract('storage.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('gs://user-uploads/');
    expect(urls).toContain('gs://static-assets/');
    expect(urls).toContain('gs://temp-bucket/');
  });

  it('marks dynamic bucket as dynamic egress and null URL', async () => {
    const batch = await extract('storage.ts');
    const dyn = callers(batch).find((c) => c.urlLiteral === null);
    expect(dyn).toBeDefined();
    expect(dyn?.egressConfidence).toBe('dynamic');
  });

  it('marks literal bucket + dynamic key as dynamic with gs://bucket/ URL', async () => {
    const batch = await extract('storage.ts');
    const dynKey = callers(batch).filter(
      (c) => c.urlLiteral === 'gs://static-assets/' && c.egressConfidence === 'dynamic',
    );
    // dynamicKey produces gs://static-assets/ (dynamic)
    expect(dynKey.length).toBe(1);
  });

  it('stamps isExternal=true and externalHost=<bucket>.storage.googleapis.com', async () => {
    const batch = await extract('storage.ts');
    const fetched = callers(batch).find((c) => c.urlLiteral === 'gs://static-assets/logo.png');
    expect(fetched?.isExternal).toBe(true);
    expect(fetched?.externalHost).toBe('static-assets.storage.googleapis.com');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('storage.ts');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no @google-cloud/storage import', async () => {
    const batch = await extract('no_imports.ts');
    expect(callers(batch)).toEqual([]);
  });
});
