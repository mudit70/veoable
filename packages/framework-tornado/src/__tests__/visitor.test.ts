import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import type { APIEndpoint, SchemaNode } from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { PyLanguagePlugin } from '@veoable/lang-py';
import { TornadoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/tornado/basic');

async function extract(file: string): Promise<NodeBatch> {
  const tornado = new TornadoPlugin();
  const py = new PyLanguagePlugin();
  py.registerVisitor(tornado.visitor);
  const handle = await py.loadProject({ rootDir: FIXTURE_ROOT });
  return py.extractFile(handle, file);
}

const endpoints = (b: { nodes: SchemaNode[] }): APIEndpoint[] =>
  b.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');

describe('framework-tornado visitor', () => {
  it('emits one APIEndpoint per HTTP-verb method × URL on a RequestHandler subclass', async () => {
    const batch = await extract('server.py');
    // UserHandler: get, post, put, delete = 4 verbs × 1 URL = 4
    // HealthHandler: get, head = 2 verbs × 1 URL = 2
    // SpecStyleHandler: get, patch = 2 verbs × 1 URL = 2
    // UnregisteredHandler: get = 1 verb × 1 (synthetic) URL = 1
    // AliasedHandler: get = 1 verb × 2 URLs (legacy alias) = 2
    // UrlFormHandler: get = 1 verb × 1 URL (url() form) = 1
    // FakeHandler: 0 (not a RequestHandler)
    expect(endpoints(batch).length).toBe(12);
  });

  it('honors scoped (tornado.web.RequestHandler) and bare (RequestHandler) superclasses', async () => {
    const batch = await extract('server.py');
    // The bare-form HealthHandler emits at /health (from Application).
    const health = endpoints(batch).find((e) => e.routePattern === '/health');
    expect(health).toBeTruthy();
  });

  it('resolves the URL from Application([(URL, Handler)]) tuple form', async () => {
    const batch = await extract('server.py');
    const userEps = endpoints(batch).filter((e) => e.routePattern === '/users');
    expect(userEps.length).toBe(4);  // get, post, put, delete
    const verbs = userEps.map((e) => e.httpMethod).sort();
    expect(verbs).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
  });

  it('resolves the URL from URLSpec(URL, Handler) constructor form', async () => {
    const batch = await extract('server.py');
    const specEps = endpoints(batch).filter((e) => e.routePattern === '/spec-style');
    expect(specEps.length).toBe(2);  // get + patch
  });

  it('skips non-verb methods like initialize()', async () => {
    const batch = await extract('server.py');
    const eps = endpoints(batch);
    // initialize() is not a verb — must NOT emit.
    expect(eps.some((e) => e.httpMethod === 'INITIALIZE')).toBe(false);
  });

  it('does NOT emit for a class that does NOT inherit from RequestHandler', async () => {
    const batch = await extract('server.py');
    const eps = endpoints(batch);
    expect(eps.some((e) => e.routePattern.includes('FakeHandler'))).toBe(false);
  });

  it('falls back to synthetic /handler/<ClassName> URL when not registered', async () => {
    const batch = await extract('server.py');
    const unreg = endpoints(batch).find(
      (e) => e.routePattern === '/handler/UnregisteredHandler',
    );
    expect(unreg).toBeTruthy();
  });

  it('stamps confidence=heuristic on synthetic URLs and exact on resolved ones', async () => {
    const batch = await extract('server.py');
    const synthetic = endpoints(batch).find(
      (e) => e.routePattern === '/handler/UnregisteredHandler',
    );
    expect(synthetic!.evidence?.confidence).toBe('heuristic');
    const resolved = endpoints(batch).find((e) => e.routePattern === '/users');
    expect(resolved!.evidence?.confidence).toBe('exact');
  });

  it('marks every endpoint with framework=tornado + httpMethod uppercased', async () => {
    const batch = await extract('server.py');
    for (const e of endpoints(batch)) {
      expect(e.framework).toBe('tornado');
      expect(e.httpMethod).toBe(e.httpMethod.toUpperCase());
    }
  });

  it('emits one APIEndpoint per URL when a handler is registered at multiple URLs', async () => {
    // Reviewer-flagged: `[(r'/v1/aliased', X), (r'/aliased', X)]`
    // is a real Tornado legacy-alias pattern. Pre-fix the visitor's
    // last-write-wins map silently dropped /v1/aliased; now both
    // emit.
    const batch = await extract('server.py');
    const aliasedEps = endpoints(batch).filter((e) =>
      e.handlerFunctionId && (e.routePattern === '/v1/aliased' || e.routePattern === '/aliased'),
    );
    expect(aliasedEps.length).toBe(2);
    const patterns = aliasedEps.map((e) => e.routePattern).sort();
    expect(patterns).toEqual(['/aliased', '/v1/aliased']);
  });

  it('resolves URLs from the lowercase `tornado.web.url(URL, Handler)` form', async () => {
    const batch = await extract('server.py');
    const urlForm = endpoints(batch).find((e) => e.routePattern === '/url-form');
    expect(urlForm).toBeTruthy();
    expect(urlForm!.httpMethod).toBe('GET');
  });
});
