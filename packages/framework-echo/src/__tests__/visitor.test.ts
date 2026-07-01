import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { EchoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/echo/basic');

async function extract(file: string): Promise<NodeBatch> {
  const plugin = new EchoPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(plugin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-echo visitor', () => {
  it('emits APIEndpoint for each method shape', async () => {
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

  it('emits ALL for e.Any(...)', async () => {
    const batch = await extract('server.go');
    const any = endpoints(batch).find((e) => e.routePattern === '/echo');
    expect(any?.httpMethod).toBe('ALL');
  });

  it('emits one endpoint per method listed in e.Match([]string{...}, ...)', async () => {
    const batch = await extract('server.go');
    const either = endpoints(batch).filter((e) => e.routePattern === '/either');
    const methods = new Set(either.map((e) => e.httpMethod));
    expect(methods.has('GET')).toBe(true);
    expect(methods.has('POST')).toBe(true);
  });

  it('composes group prefixes for nested e.Group chains', async () => {
    const batch = await extract('server.go');
    const routes = endpoints(batch).map((e) => e.routePattern);
    expect(routes).toContain('/api/v1/profile');
  });

  it('every endpoint carries framework="echo"', async () => {
    const batch = await extract('server.go');
    for (const e of endpoints(batch)) expect(e.framework).toBe('echo');
  });

  it('rejects all emits in files without echo import', async () => {
    const batch = await extract('no_imports.go');
    expect(endpoints(batch)).toEqual([]);
  });
});
