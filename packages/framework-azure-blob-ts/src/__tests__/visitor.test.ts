import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientSideAPICaller, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { AzureBlobTsPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/azure-blob-ts/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new AzureBlobTsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });
  return ts.extractFile(handle, file);
}

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-azure-blob-ts visitor', () => {
  it('emits one ClientSideAPICaller per Azure Blob leaf method', async () => {
    const batch = await extract('storage.ts');
    // 12 fluent chains in the fixture
    expect(callers(batch).length).toBe(12);
  });

  it('maps methods to HTTP verbs', async () => {
    const batch = await extract('storage.ts');
    const byMethod = new Map<string, number>();
    for (const c of callers(batch)) {
      byMethod.set(c.httpMethod ?? '', (byMethod.get(c.httpMethod ?? '') ?? 0) + 1);
    }
    expect(byMethod.get('GET')).toBe(5);
    expect(byMethod.get('PUT')).toBe(5);
    expect(byMethod.get('DELETE')).toBe(2);
  });

  it('every caller carries framework="azure-blob-ts"', async () => {
    const batch = await extract('storage.ts');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('azure-blob-ts');
    }
  });

  it('builds azure://<container>/<blob> URLs for blob-scope chains', async () => {
    const batch = await extract('storage.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('azure://static-assets/logo.png');
    expect(urls).toContain('azure://user-uploads/inbox/new.txt');
    expect(urls).toContain('azure://archive/2026/snapshot.tar');
    expect(urls).toContain('azure://configs/app.json');
    expect(urls).toContain('azure://logs/system.log');
    expect(urls).toContain('azure://vhd/disk.vhd');
  });

  it('builds azure://<container>/ URLs for container-scope chains', async () => {
    const batch = await extract('storage.ts');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).toContain('azure://static-assets/');   // listBlobsFlat (exact)
    expect(urls).toContain('azure://temp-container/');  // deleteContainer (exact)
    expect(urls).toContain('azure://new-container/');   // createContainer (exact)
  });

  it('marks dynamic container as dynamic egress and null URL', async () => {
    const batch = await extract('storage.ts');
    const dyn = callers(batch).find((c) => c.urlLiteral === null);
    expect(dyn).toBeDefined();
    expect(dyn?.egressConfidence).toBe('dynamic');
  });

  it('marks literal container + dynamic blob as dynamic with azure://container/ URL', async () => {
    const batch = await extract('storage.ts');
    const dynKey = callers(batch).filter(
      (c) => c.urlLiteral === 'azure://static-assets/' && c.egressConfidence === 'dynamic',
    );
    expect(dynKey.length).toBe(1);
  });

  it('stamps isExternal=true and externalHost=<container>.blob.core.windows.net', async () => {
    const batch = await extract('storage.ts');
    const fetched = callers(batch).find((c) => c.urlLiteral === 'azure://static-assets/logo.png');
    expect(fetched?.isExternal).toBe(true);
    expect(fetched?.externalHost).toBe('static-assets.blob.core.windows.net');
  });

  it('emits MAKES_REQUEST edges from caller function to ClientSideAPICaller', async () => {
    const batch = await extract('storage.ts');
    const reqs = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(reqs.length).toBe(callers(batch).length);
  });

  it('rejects all emits in a file with no @azure/storage-blob import', async () => {
    const batch = await extract('no_imports.ts');
    expect(callers(batch)).toEqual([]);
  });
});
