import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { WarpPlugin } from '../index.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/warp/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new WarpPlugin();
  const rust = new RustLanguagePlugin();
  plugin.onProjectLoaded?.({
    rootDir: FIXTURE_ROOT,
    repository: 'warp-fixture',
    files: ['src/main.rs', 'src/no_imports.rs'],
    packageJson: null,
  } as any);
  rust.registerVisitor(plugin.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-warp visitor', () => {
  it('emits one APIEndpoint per warp::path!() macro', async () => {
    const batch = await extract('src/main.rs');
    // 6 path! invocations
    expect(endpoints(batch).length).toBe(6);
  });

  it('extracts path segments with :param for type identifiers', async () => {
    const batch = await extract('src/main.rs');
    const routes = endpoints(batch).map((e) => e.routePattern).sort();
    expect(routes).toContain('/api/users/:u32');
    expect(routes).toContain('/api/users');
    expect(routes).toContain('/api/orders');
  });

  it('uses * for `..` rest patterns', async () => {
    const batch = await extract('src/main.rs');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('/echo/*');
  });

  it('infers method from enclosing warp::get()/post()/delete()', async () => {
    const batch = await extract('src/main.rs');
    const byRoute = new Map<string, string>();
    for (const e of endpoints(batch)) byRoute.set(e.routePattern, e.httpMethod);
    expect(byRoute.get('/api/orders')).toBe('ALL');
  });

  it('every endpoint carries framework="warp"', async () => {
    const batch = await extract('src/main.rs');
    for (const e of endpoints(batch)) expect(e.framework).toBe('warp');
  });

  it('rejects all emits in files without warp crate use', async () => {
    const batch = await extract('src/no_imports.rs');
    expect(endpoints(batch)).toEqual([]);
  });
});
