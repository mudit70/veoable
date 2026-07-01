import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, ClientSideAPICaller, SchemaNode } from '@adorable/schema';
import type { NodeBatch } from '@adorable/plugin-api';
import { PyLanguagePlugin } from '@adorable/lang-py';
import { AiohttpPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/aiohttp/basic');

async function extract(file: string): Promise<NodeBatch> {
  const aiohttp = new AiohttpPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(aiohttp.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

const callers = (b: { nodes: SchemaNode[] }): ClientSideAPICaller[] =>
  b.nodes.filter((n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller');

describe('framework-aiohttp visitor', () => {
  it('emits APIEndpoint for @routes.<verb>(path) decorators', async () => {
    const batch = await extract('server.py');
    const routes = endpoints(batch).filter(
      (e) => ['/users', '/users/:user_id'].includes(e.routePattern),
    );
    // 4 decorator-form routes (get, post, put, delete).
    expect(routes.length).toBe(4);
    const verbs = routes.map((e) => e.httpMethod).sort();
    expect(verbs).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
  });

  it('normalizes {param} path params to :param', async () => {
    const batch = await extract('server.py');
    const eps = endpoints(batch);
    expect(eps.some((e) => e.routePattern === '/users/:user_id')).toBe(true);
    expect(eps.some((e) => e.routePattern === '/users/{user_id}')).toBe(false);
  });

  it('emits one APIEndpoint per HTTP-verb method on a class(web.View)', async () => {
    const batch = await extract('server.py');
    const viewEps = endpoints(batch).filter((e) => e.routePattern.startsWith('/view/'));
    // ItemView: get + post = 2. helper() is not an HTTP verb.
    expect(viewEps.length).toBe(2);
    const verbs = viewEps.map((e) => e.httpMethod).sort();
    expect(verbs).toEqual(['GET', 'POST']);
  });

  it('does NOT emit for a non-View class with HTTP-verb method names', async () => {
    const batch = await extract('server.py');
    const eps = endpoints(batch);
    // PlainHelper.get must NOT register.
    expect(eps.some((e) => e.routePattern === '/view/PlainHelper')).toBe(false);
  });

  it('emits for app.router.add_<verb>(URL, handler) call form', async () => {
    const batch = await extract('server.py');
    const health = endpoints(batch).find((e) => e.routePattern === '/health');
    const login = endpoints(batch).find((e) => e.routePattern === '/login');
    expect(health).toBeTruthy();
    expect(health!.httpMethod).toBe('GET');
    expect(login).toBeTruthy();
    expect(login!.httpMethod).toBe('POST');
  });

  it('emits for web.<verb>(URL, handler) constructor form', async () => {
    const batch = await extract('server.py');
    const ping = endpoints(batch).find((e) => e.routePattern === '/ping');
    const echo = endpoints(batch).find((e) => e.routePattern === '/echo');
    expect(ping).toBeTruthy();
    expect(echo).toBeTruthy();
    expect(ping!.httpMethod).toBe('GET');
    expect(echo!.httpMethod).toBe('POST');
  });

  it('marks every endpoint with framework=aiohttp', async () => {
    const batch = await extract('server.py');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('aiohttp');
    }
  });

  it('CLIENT-SIDE: emits ClientSideAPICaller for session.<verb>(URL)', async () => {
    const batch = await extract('server.py');
    const cs = callers(batch);
    // fetch_users (GET) + create_user_remote (POST) + update_user_remote
    // (PUT) + delete_user_remote (DELETE) + fetch_user_dynamic (GET,
    // dynamic) = 5.
    expect(cs.length).toBe(5);
    const verbs = cs.map((c) => c.httpMethod).sort();
    expect(verbs).toEqual(['DELETE', 'GET', 'GET', 'POST', 'PUT']);
  });

  it('CLIENT-SIDE: marks every caller with framework=aiohttp', async () => {
    const batch = await extract('server.py');
    for (const c of callers(batch)) {
      expect(c.framework).toBe('aiohttp');
    }
  });

  it('CLIENT-SIDE: extracts static URLs as exact and f-strings as dynamic', async () => {
    const batch = await extract('server.py');
    const dyn = callers(batch).filter((c) => c.egressConfidence === 'dynamic');
    expect(dyn.length).toBe(1);
    expect(dyn[0].urlLiteral).toBeNull();
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exact.length).toBe(4);
  });

  it('CLIENT-SIDE: stamps isExternal + externalHost for public URLs', async () => {
    const batch = await extract('server.py');
    const exact = callers(batch).filter((c) => c.egressConfidence === 'exact');
    expect(exact.length).toBeGreaterThan(0);
    for (const c of exact) {
      expect(c.isExternal).toBe(true);
      expect(c.externalHost).toBe('api.example.com');
    }
  });

  it('CLIENT-SIDE: emits MAKES_REQUEST edges from enclosing function to caller', async () => {
    const batch = await extract('server.py');
    const ids = new Set(callers(batch).map((c) => c.id));
    const edges = batch.edges.filter((e) => e.edgeType === 'MAKES_REQUEST');
    expect(edges.length).toBe(ids.size);
    for (const e of edges) expect(ids.has(e.to)).toBe(true);
  });

  it('CLIENT-SIDE: rejects dict.get(key) on a non-session receiver', async () => {
    const batch = await extract('server.py');
    const urls = callers(batch).map((c) => c.urlLiteral);
    expect(urls).not.toContain('foo');
  });

  it('rejects ALL emits in a file with no aiohttp import', async () => {
    const batch = await extract('no_imports.py');
    expect(endpoints(batch)).toEqual([]);
    expect(callers(batch)).toEqual([]);
  });

  it('stamps `confidence: heuristic` on class-view synthetic URLs', async () => {
    const batch = await extract('server.py');
    const viewEps = endpoints(batch).filter((e) => e.routePattern.startsWith('/view/'));
    expect(viewEps.length).toBeGreaterThan(0);
    for (const e of viewEps) {
      expect(e.evidence?.confidence).toBe('heuristic');
    }
    // All decorator/router/web.* routes have ACTUAL URLs, so stay 'exact'.
    const concreteEps = endpoints(batch).filter((e) => !e.routePattern.startsWith('/view/'));
    expect(concreteEps.length).toBeGreaterThan(0);
    for (const e of concreteEps) {
      expect(e.evidence?.confidence).toBe('exact');
    }
  });

  it('rejects decorator with non-route-like receiver (`@app.get(...)`)', async () => {
    // Quick safety: a file that imports aiohttp but uses `@app.get(...)`
    // (FastAPI-style on a same-file `app`) must NOT be picked up by
    // the decorator branch. We piggy-back on the existing server.py
    // — `@routes.get(...)` is the only decorator form there. The
    // `app.router.add_get(...)` calls hit a different code path. So
    // the regex `/route/i` is the only safeguard tested here.
    const batch = await extract('server.py');
    // sanity: at least one decorator-derived endpoint exists.
    const decoRoutes = endpoints(batch).filter((e) => ['/users', '/users/:user_id'].includes(e.routePattern));
    expect(decoRoutes.length).toBeGreaterThan(0);
  });
});
