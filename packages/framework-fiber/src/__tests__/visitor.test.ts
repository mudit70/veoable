import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { FiberPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/fiber/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new FiberPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-fiber visitor', () => {
  it('emits APIEndpoint per HTTP method with uppercase httpMethod', async () => {
    const batch = await extract('server.go');
    const byKey = new Set(endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`));
    expect(byKey.has('GET /ping')).toBe(true);
    expect(byKey.has('POST /login')).toBe(true);
    expect(byKey.has('PUT /users/:id')).toBe(true);
    expect(byKey.has('DELETE /users/:id')).toBe(true);
    expect(byKey.has('PATCH /users/:id')).toBe(true);
    expect(byKey.has('HEAD /health')).toBe(true);
    expect(byKey.has('OPTIONS /health')).toBe(true);
  });

  it('emits ALL for app.All(...)', async () => {
    const batch = await extract('server.go');
    const all = endpoints(batch).find((e) => e.routePattern === '/echo');
    expect(all?.httpMethod).toBe('ALL');
  });

  it('emits arbitrary methods via app.Add(method, path, h)', async () => {
    const batch = await extract('server.go');
    const audit = endpoints(batch).find((e) => e.routePattern === '/audit');
    expect(audit?.httpMethod).toBe('REPORT');
  });

  it('composes group prefixes', async () => {
    const batch = await extract('server.go');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('/api/v1/profile');
  });

  it('every endpoint carries framework="fiber"', async () => {
    const batch = await extract('server.go');
    for (const e of endpoints(batch)) expect(e.framework).toBe('fiber');
  });

  it('rejects all emits in files without fiber import', async () => {
    const batch = await extract('no_imports.go');
    expect(endpoints(batch)).toEqual([]);
  });
});
