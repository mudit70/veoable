import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { ChiPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/chi/basic');

async function extract(file: string): Promise<NodeBatch> {
  const chi = new ChiPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(chi.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-chi visitor', () => {
  it('emits APIEndpoint for r.<verb>(path, handler) — all 7 standard verbs', async () => {
    const batch = await extract('router.go');
    const standard = endpoints(batch).filter((e) =>
      ['/users', '/users/:id'].includes(e.routePattern),
    );
    // 7 verbs on /users or /users/:id from the canonical newRouter().
    expect(standard.length).toBe(7);
    const verbs = standard.map((e) => e.httpMethod).sort();
    expect(verbs).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  });

  it('normalizes {param} → :param', async () => {
    const batch = await extract('router.go');
    const eps = endpoints(batch);
    expect(eps.some((e) => e.routePattern === '/users/:id')).toBe(true);
    expect(eps.some((e) => e.routePattern === '/users/{id}')).toBe(false);
  });

  it('handles r.Method("CUSTOM", path, handler)', async () => {
    const batch = await extract('router.go');
    const custom = endpoints(batch).find((e) => e.routePattern === '/custom-path');
    expect(custom).toBeTruthy();
    expect(custom!.httpMethod).toBe('CUSTOM');
  });

  it('handles r.MethodFunc("PROPFIND", path, fn) including non-standard verbs', async () => {
    const batch = await extract('router.go');
    const propfind = endpoints(batch).find((e) => e.routePattern === '/webdav');
    expect(propfind).toBeTruthy();
    expect(propfind!.httpMethod).toBe('PROPFIND');
  });

  it('handles r.HandleFunc(path, fn) as method=ALL', async () => {
    const batch = await extract('router.go');
    const legacy = endpoints(batch).find((e) => e.routePattern === '/legacy');
    expect(legacy).toBeTruthy();
    expect(legacy!.httpMethod).toBe('ALL');
  });

  it('marks every endpoint with framework=chi', async () => {
    const batch = await extract('router.go');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('chi');
    }
  });

  it('matches `mux` receiver name via the heuristic', async () => {
    const batch = await extract('router.go');
    const health = endpoints(batch).find((e) => e.routePattern === '/health');
    expect(health).toBeTruthy();
    expect(health!.httpMethod).toBe('GET');
  });

  it('matches `apiRouter` (a custom *Router suffix name) via the heuristic', async () => {
    const batch = await extract('router.go');
    const named = endpoints(batch).find((e) => e.routePattern === '/api/things');
    expect(named).toBeTruthy();
  });

  it('does NOT emit for a non-router receiver (`kvStore.Get(literal)`)', async () => {
    const batch = await extract('router.go');
    const eps = endpoints(batch);
    expect(eps.some((e) => e.routePattern === '/this/is/not/a/route')).toBe(false);
  });

  it('emits nothing in files without the chi import', async () => {
    const batch = await extract('no_imports.go');
    expect(endpoints(batch)).toEqual([]);
  });
});
