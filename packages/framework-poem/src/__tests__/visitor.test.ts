import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { PoemPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/poem/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new PoemPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'poem-fixture',
    files: ['src/main.rs', 'src/no_imports.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-poem visitor', () => {
  it('emits one endpoint per (path, method) pair', async () => {
    const batch = await extract('src/main.rs');
    // /hello → GET (1)
    // /users → GET, POST (2)
    // /users/:id → PUT, DELETE (2)
    // /health → GET (1)
    expect(endpoints(batch).length).toBe(6);
  });

  it('extracts chained get(...).post(...) methods', async () => {
    const batch = await extract('src/main.rs');
    const usersMethods = endpoints(batch)
      .filter((e) => e.routePattern === '/users')
      .map((e) => e.httpMethod)
      .sort();
    expect(usersMethods).toEqual(['GET', 'POST']);
  });

  it('extracts chained put().delete() on a parameterized path', async () => {
    const batch = await extract('src/main.rs');
    const userIdMethods = endpoints(batch)
      .filter((e) => e.routePattern === '/users/:id')
      .map((e) => e.httpMethod)
      .sort();
    expect(userIdMethods).toEqual(['DELETE', 'PUT']);
  });

  it('every endpoint carries framework="poem"', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) expect(e.framework).toBe('poem');
  });

  it('rejects all emits in files without poem crate use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(endpoints(batch)).toEqual([]);
  });
});
