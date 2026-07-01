import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { GoLanguagePlugin } from '@adorable/lang-go';
import { GinPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/go/gin');

async function extract(file: string): Promise<NodeBatch> {
  const gin = new GinPlugin();
  const go = new GoLanguagePlugin();
  go.registerVisitor(gin.visitor);
  const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
  return go.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('gin route detection', () => {
  it('detects all standard HTTP verbs', async () => {
    const batch = await extract('server.go');
    const eps = endpoints(batch);
    const methods = new Set(eps.map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('HEAD');
    expect(methods).toContain('OPTIONS');
  });

  it('captures route patterns', async () => {
    const batch = await extract('server.go');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => e.routePattern);
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:id');
  });

  it('sets framework="gin"', async () => {
    const batch = await extract('server.go');
    for (const ep of endpoints(batch)) {
      expect(ep.framework).toBe('gin');
    }
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('server.go');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

describe('negative cases', () => {
  it('does not match non-Gin receivers', async () => {
    const batch = await extract('negatives.go');
    expect(endpoints(batch)).toHaveLength(0);
  });
});

describe('GinPlugin contract', () => {
  it('has id="gin" and language="go"', () => {
    const plugin = new GinPlugin();
    expect(plugin.id).toBe('gin');
    expect(plugin.language).toBe('go');
  });
});

describe('Gin route group prefix composition (#204)', () => {
  it('composes router.Group("/api") + method.GET("/health") → /api/health', async () => {
    const batch = await extract('groups.go');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/health');
  });

  it('composes nested groups: api.Group("/v1") + GET("/profile") → /api/v1/profile', async () => {
    const batch = await extract('groups.go');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/v1/profile');
    expect(patterns).toContain('PUT /api/v1/profile/:id');
  });

  it('composes Handle and Any methods through the group prefix', async () => {
    const batch = await extract('groups.go');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /api/v2/orders');
    expect(patterns).toContain('ALL /api/v2/ping');
  });

  it('plain router routes do NOT pick up any group prefix', async () => {
    const batch = await extract('groups.go');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    expect(patterns).toContain('GET /version');
  });

  it('the un-prefixed test fixture still emits unprefixed routes (no false positive)', async () => {
    const batch = await extract('server.go');
    const patterns = endpoints(batch).map((e) => `${e.httpMethod} ${e.routePattern}`);
    // server.go has no Group(...) calls — no prefix should be inferred.
    expect(patterns).toContain('GET /users');
    expect(patterns).toContain('GET /users/:id');
    for (const p of patterns) expect(p).not.toMatch(/\s\/api/);
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const gin = new GinPlugin();
      const go = new GoLanguagePlugin();
      go.registerVisitor(gin.visitor);
      const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });

      const batch = await go.extractFile(handle, 'server.go');
      store.commit(batch, makeBatchMeta('go'));

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('gin');
      }
    } finally {
      store.close();
    }
  });
});

describe('handler-function-id resolution (#523-style follow-up)', () => {
  // A second extract helper that runs the project-load pass before
  // extraction so the handler resolver populates its map.
  async function extractWithProjectLoad(file: string): Promise<NodeBatch> {
    const gin = new GinPlugin();
    // ctx fields the plugin reads in onProjectLoaded: rootDir.
    gin.onProjectLoaded({ rootDir: FIXTURE_ROOT } as any);
    const go = new GoLanguagePlugin();
    go.registerVisitor(gin.visitor);
    const handle = await go.loadProject({ rootDir: FIXTURE_ROOT });
    return go.extractFile(handle, file);
  }

  it('resolves bare free-function handlers to a FunctionDefinition id', async () => {
    const batch = await extractWithProjectLoad('handlers_routes.go');
    const eps = endpoints(batch);
    const bare = eps.find((e) => e.routePattern === '/api/bare');
    expect(bare).toBeDefined();
    expect(bare!.handlerFunctionId, 'bare-handler id should be resolved').toBeTruthy();
  });

  it('resolves method-receiver handlers (v.List, v.Get, v.Create)', async () => {
    const batch = await extractWithProjectLoad('handlers_routes.go');
    const eps = endpoints(batch);
    for (const path of ['/api/vehicles', '/api/vehicles/:id']) {
      for (const e of eps.filter((x) => x.routePattern === path)) {
        expect(e.handlerFunctionId, `${e.httpMethod} ${e.routePattern} should resolve`).toBeTruthy();
      }
    }
  });

  it('returns null for inline anonymous function-literal handlers', async () => {
    const batch = await extractWithProjectLoad('handlers_routes.go');
    const eps = endpoints(batch);
    const inline = eps.find((e) => e.routePattern === '/api/inline');
    expect(inline).toBeDefined();
    expect(inline!.handlerFunctionId, 'inline anonymous handler must NOT resolve').toBeNull();
  });

  it('returns null when a method name is globally ambiguous (two structs, same method)', async () => {
    // handlers.go defines AmbigA.Same AND AmbigB.Same. The resolver
    // must collapse the duplicate to null rather than pick one
    // arbitrarily.
    const batch = await extractWithProjectLoad('handlers_routes.go');
    const eps = endpoints(batch);
    const ambig = eps.find((e) => e.routePattern === '/api/ambig');
    expect(ambig).toBeDefined();
    expect(ambig!.handlerFunctionId, 'ambiguous method name must NOT resolve').toBeNull();
  });

  it('still leaves handlerFunctionId null when the plugin was used without onProjectLoaded', async () => {
    // Regression pin for the default-construction path — plugin without
    // a project-load pass behaves like the pre-fix version.
    const batch = await extract('handlers_routes.go');
    const eps = endpoints(batch);
    for (const e of eps) {
      expect(e.handlerFunctionId, `${e.routePattern} should be null without onProjectLoaded`).toBeNull();
    }
  });

  it('resolves the handler in `r.Handle("METHOD", "/path", v.List)` (3-arg form)', async () => {
    // Pin the 3-arg shape — the visitor advances the handler arg
    // position to 2 here. Same lookup semantics as the 2-arg form.
    const batch = await extractWithProjectLoad('handlers_routes.go');
    const eps = endpoints(batch);
    const handle = eps.find((e) => e.routePattern === '/api/handle');
    expect(handle).toBeDefined();
    expect(handle!.httpMethod).toBe('GET');
    expect(handle!.handlerFunctionId, 'r.Handle handler should resolve').toBeTruthy();
  });

  it('does NOT regress the existing per-file extraction for server.go', async () => {
    const batch = await extractWithProjectLoad('server.go');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(8);
    // Pin that the existing bare-handler shapes in server.go now also
    // resolve under the project-load pass.
    const listUsers = eps.find((e) => e.routePattern === '/users' && e.httpMethod === 'GET');
    expect(listUsers!.handlerFunctionId, 'listUsers should resolve').toBeTruthy();
  });
});
