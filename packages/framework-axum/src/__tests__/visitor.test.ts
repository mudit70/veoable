import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { RustLanguagePlugin } from '@veoable/lang-rust';
import { AxumPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/rust/axum');

async function extract(file: string): Promise<NodeBatch> {
  const axum = new AxumPlugin();
  const rust = new RustLanguagePlugin();
  rust.registerVisitor(axum.visitor);
  const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
  return rust.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('axum route builder detection', () => {
  it('detects routes from .route() builder calls', async () => {
    const batch = await extract('server.rs');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(2);
  });

  it('detects chained method routers (get + post on same path)', async () => {
    const batch = await extract('server.rs');
    const eps = endpoints(batch);
    const usersMethods = eps
      .filter((e) => e.routePattern === '/users')
      .map((e) => e.httpMethod)
      .sort();
    expect(usersMethods).toContain('GET');
    expect(usersMethods).toContain('POST');
  });

  it('detects multiple routes with different paths', async () => {
    const batch = await extract('server.rs');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:id');
  });

  it('sets framework="axum"', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('axum');
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('server.rs');
    for (const ep of endpoints(batch)) expect(() => validateNode(ep)).not.toThrow();
  });
});

describe('Axum nest prefix composition (#204)', () => {
  it('composes nest("/api", api) prefix onto routes registered on `api`', async () => {
    const batch = await extract('nested.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/users');
    expect(patterns).toContain('GET /api/users/:id');
  });

  it('composes a different nest prefix for a sibling router', async () => {
    const batch = await extract('nested.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/v1/profile');
  });

  it('routes on the outer (un-nested) router are NOT prefixed', async () => {
    const batch = await extract('nested.rs');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /health');
  });

  it('un-nested fixture (server.rs) still emits unprefixed routes', async () => {
    const batch = await extract('server.rs');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    // server.rs has no nest(...) calls — no prefix should be inferred.
    for (const p of patterns) expect(p).not.toMatch(/^\/api\//);
  });
});

describe('AxumPlugin contract', () => {
  it('has id="axum" and language="rust"', () => {
    const plugin = new AxumPlugin();
    expect(plugin.id).toBe('axum');
    expect(plugin.language).toBe('rust');
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const axum = new AxumPlugin();
      const rust = new RustLanguagePlugin();
      rust.registerVisitor(axum.visitor);
      const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
      const batch = await rust.extractFile(handle, 'server.rs');
      store.commit(batch, makeBatchMeta('rust'));
      expect(store.findNodes('APIEndpoint').length).toBeGreaterThan(0);
    } finally { store.close(); }
  });
});

describe('handler-function-id resolution', () => {
  // Variant of `extract` that runs the project-load pass first so
  // the resolver populates its handler map. Mirrors framework-gin's
  // test harness for the same fix.
  async function extractWithProjectLoad(file: string): Promise<NodeBatch> {
    const axum = new AxumPlugin();
    axum.onProjectLoaded({ rootDir: FIXTURE_ROOT } as any);
    const rust = new RustLanguagePlugin();
    rust.registerVisitor(axum.visitor);
    const handle = await rust.loadProject({ rootDir: FIXTURE_ROOT });
    return rust.extractFile(handle, file);
  }

  it('resolves bare-identifier handlers (`get(handler_fn)`)', async () => {
    const batch = await extractWithProjectLoad('handlers.rs');
    const eps = endpoints(batch);
    const portfolio = eps.find((e) => e.routePattern === '/api/portfolio');
    expect(portfolio).toBeDefined();
    expect(portfolio!.handlerFunctionId, 'get_portfolio should resolve').toBeTruthy();
  });

  it('leaves scoped-path handlers pointing at module-nested fns as null (v1 limitation)', async () => {
    // `get(orders::list)` where `orders::list` is defined inside an
    // inline `mod orders { pub async fn list() {…} }` block.
    // lang-rust's structural pass doesn't recurse into mod_item
    // bodies, so it emits NO FunctionDefinition for that fn. The
    // resolver MUST refuse to mint a dangling id pointing at the
    // missing node — pinned here so a regression that started
    // emitting an id would be caught immediately. (Cross-FILE
    // scoped paths like `crate::orders::list` where `orders` is a
    // separate `orders.rs` file DO resolve.)
    const batch = await extractWithProjectLoad('handlers.rs');
    const eps = endpoints(batch);
    const list = eps.find((e) => e.routePattern === '/api/orders/list');
    expect(list).toBeDefined();
    expect(
      list!.handlerFunctionId,
      'module-nested fn must NOT resolve (would dangle)',
    ).toBeNull();
  });

  it('resolves every method in a chained method-router (get.post.delete)', async () => {
    const batch = await extractWithProjectLoad('handlers.rs');
    const ordersEps = endpoints(batch).filter((e) => e.routePattern === '/api/orders');
    // get(list_orders).post(place_order).delete(cancel_order) — three
    // endpoints share the same path, each with its own resolved handler.
    expect(ordersEps.length).toBe(3);
    for (const e of ordersEps) {
      expect(e.handlerFunctionId, `${e.httpMethod} ${e.routePattern} should resolve`).toBeTruthy();
    }
    // Each handler resolves to a DISTINCT FunctionDefinition id —
    // pins that we're not all collapsing to the same lookup.
    const ids = new Set(ordersEps.map((e) => e.handlerFunctionId));
    expect(ids.size).toBe(3);
  });

  it('leaves closures (`get(|| async {...})`) as null', async () => {
    const batch = await extractWithProjectLoad('handlers.rs');
    const eps = endpoints(batch);
    const health = eps.find((e) => e.routePattern === '/api/health');
    expect(health).toBeDefined();
    expect(health!.handlerFunctionId, 'closure handler must NOT resolve').toBeNull();
  });

  it('leaves ambiguous-name handlers as null (two `same` functions)', async () => {
    const batch = await extractWithProjectLoad('handlers.rs');
    const eps = endpoints(batch);
    const ambig = eps.find((e) => e.routePattern === '/api/ambig');
    expect(ambig).toBeDefined();
    expect(ambig!.handlerFunctionId, 'ambiguous lookup name must NOT resolve').toBeNull();
  });

  it('returns null for all endpoints when the plugin was used without onProjectLoaded', async () => {
    // Regression pin for the default-construction path.
    const batch = await extract('handlers.rs');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const e of eps) {
      expect(e.handlerFunctionId, `${e.routePattern} should be null without onProjectLoaded`).toBeNull();
    }
  });

  it('does NOT regress the existing server.rs extraction (now also resolves handlers)', async () => {
    const batch = await extractWithProjectLoad('server.rs');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(4);
    // server.rs uses bare handlers. `create_user` and `delete_user`
    // are unique to server.rs across the fixture root, so their ids
    // resolve. (`list_users` and `get_user` collide with definitions
    // in nested.rs and correctly stay null — the resolver refuses
    // ambiguous lookups; that's a documented correctness, not a bug.)
    const createUser = eps.find((e) => e.routePattern === '/users' && e.httpMethod === 'POST');
    expect(createUser!.handlerFunctionId, 'create_user should resolve (unique name)').toBeTruthy();
    const deleteUser = eps.find((e) => e.routePattern === '/users/:id' && e.httpMethod === 'DELETE');
    expect(deleteUser!.handlerFunctionId, 'delete_user should resolve (unique name)').toBeTruthy();
  });
});
