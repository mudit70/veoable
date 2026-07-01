import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { AzureBlobGoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/azure-blob-go/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new AzureBlobGoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-azure-blob-go visitor', () => {
  it('emits one ClientSideAPICaller per Azure Blob verb call', async () => {
    const batch = await extract('storage.go');
    expect(callers(batch).length).toBe(10);
  });

  it('maps verbs to HTTP methods', async () => {
    const batch = await extract('storage.go');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(5);
    expect(byMethod.get('PUT')).toBe(3);
    expect(byMethod.get('DELETE')).toBe(2);
  });

  it('every caller carries framework="azure-blob-go"', async () => {
    const batch = await extract('storage.go');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('azure-blob-go');
    }
  });

  it('builds azure://<container>/<blob> URLs for object-scope verbs', async () => {
    const batch = await extract('storage.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('azure://static-assets/logo.png');
    expect(urls).toContain('azure://user-uploads/inbox/new.txt');
    expect(urls).toContain('azure://archive/2026/snapshot.tar');
    expect(urls).toContain('azure://static-assets/large.bin');
    expect(urls).toContain('azure://user-uploads/movie.mp4');
    expect(urls).toContain('azure://raw-bucket/raw-key');
  });

  it('builds azure://<container>/ URLs for container-scope verbs', async () => {
    const batch = await extract('storage.go');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('azure://new-container/');
    expect(urls).toContain('azure://temp-container/');
  });

  it('marks dynamic container as dynamic egress and null URL', async () => {
    const batch = await extract('storage.go');
    const dyn = callers(batch).find((c) => c.urlLiteral === null);
    expect(dyn).toBeDefined();
    expect(dyn?.egressConfidence).toBe('dynamic');
  });

  it('marks literal container + dynamic blob as dynamic with azure://container/ URL', async () => {
    const batch = await extract('storage.go');
    const dynKey = callers(batch).filter(
      (c) => c.urlLiteral === 'azure://static-assets/' && c.egressConfidence === 'dynamic',
    );
    expect(dynKey.length).toBe(1);
  });

  it('stamps isExternal=true and externalHost=<container>.blob.core.windows.net', async () => {
    const batch = await extract('storage.go');
    const fetched = callers(batch).find((c) => c.urlLiteral === 'azure://static-assets/logo.png');
    expect(fetched?.isExternal).toBe(true);
    expect(fetched?.externalHost).toBe('static-assets.blob.core.windows.net');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('storage.go');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no azblob import', async () => {
    const batch = await extract('no_imports.go');
    expect(callers(batch)).toEqual([]);
  });
});
