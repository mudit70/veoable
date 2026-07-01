import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { RocketPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/rust/rocket');

async function extract(file: string): Promise<NodeBatch> {
  const rocket = new RocketPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(rocket.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('rocket attribute macro detection', () => {
  it('detects GET/POST/DELETE routes', async () => {
    const batch = await extract('server.rs');
    const eps = endpoints(batch);
    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  it('normalizes <param> to :param', async () => {
    const batch = await extract('server.rs');
    const eps = endpoints(batch);
    expect(eps.map((e) => e.routePattern)).toContain('/items/:id');
  });

  it('sets framework="rocket"', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('rocket');
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });

  it('strips query params from route patterns (M2)', async () => {
    const batch = await extract('server.rs');
    const search = endpoints(batch).find((e) => e.routePattern === '/search');
    expect(search).toBeDefined();
    expect(search!.httpMethod).toBe('GET');
    // Query params ?<query>&<limit> should be stripped
    expect(search!.routePattern).not.toContain('?');
  });

  it('normalizes catch-all <path..> to *path (M2)', async () => {
    const batch = await extract('server.rs');
    const files = endpoints(batch).find((e) => e.routePattern === '/files/*path');
    expect(files).toBeDefined();
    expect(files!.httpMethod).toBe('GET');
  });
});

describe('Rocket mount prefix composition (#204)', () => {
  it('composes mount("/api/users", routes![<fns>]) onto each function', async () => {
    const batch = await extract('mounted.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/users/:id');
    expect(patterns).toContain('GET /api/users/');
    expect(patterns).toContain('POST /api/users/');
  });

  it('composes a different mount path for a sibling routes! macro', async () => {
    const batch = await extract('mounted.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /health/');
  });

  it('functions not in any routes! macro stay unprefixed', async () => {
    const batch = await extract('mounted.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // list_all is defined with #[get("/")] but never mounted.
    expect(patterns).toContain('GET /');
  });

  it('scoped paths in routes![] register only the FINAL segment, not module prefixes', async () => {
    // routes![mod_x::list_users_via_module] should register
    // `list_users_via_module` (the function name), not `mod_x` (the
    // module path). A function named `users` defined in this file
    // with #[get("/static")] must NOT be falsely prefixed by any
    // routes![users::...] path elsewhere.
    const batch = await extract('mounted.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // The local `users` fn has #[get("/static")] and is NOT in any
    // routes! macro — must stay unprefixed.
    expect(patterns).toContain('GET /static');
  });

  it('a function mounted at multiple paths emits one endpoint per mount', async () => {
    const batch = await extract('mounted.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /v1/');
    expect(patterns).toContain('GET /v2/');
  });

  it('un-mounted fixture still emits unprefixed routes', async () => {
    const batch = await extract('server.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    for (const p of patterns) expect(p).not.toMatch(/^\/api\b/);
  });
});

describe('RocketPlugin contract', () => {
  it('has id="rocket" and language="rust"', () => {
    const plugin = new RocketPlugin();
    expect(plugin.id).toBe('rocket');
    expect(plugin.language).toBe('rust');
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const rocket = new RocketPlugin();
      const rust = new RustLanguagePlugin();
      rust.registerVisitor(rocket.visitor);
      const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
      const batch = await rust.extractFile(handle, 'server.rs');
      store.commit(batch, makeBatchMeta('rust'));
      expect(store.findNodes('APIEndpoint').length).toBeGreaterThan(0);
    } finally { store.close(); }
  });
});
