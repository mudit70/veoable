import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type APIEndpoint,
  type RendersEdge,
  type SchemaEdge,
  type SchemaNode,
  type Screen,
} from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { KoaPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/koa');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const koa = new KoaPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(koa.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// Canonical router.METHOD(path, handler) detection
// ──────────────────────────────────────────────────────────────────────

describe('canonical koa-router route detection', () => {
  let batch: NodeBatch;

  it('every emitted endpoint passes canonical schema validation', async () => {
    batch = await extract('basic', 'src/server.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(() => validateNode(ep)).not.toThrow();
  });

  it('detects every standard koa-router verb at least once', async () => {
    batch = await extract('basic', 'src/server.ts');
    const methods = new Set(endpoints(batch).map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('HEAD');
    expect(methods).toContain('OPTIONS');
    expect(methods).toContain('ALL');
  });

  it('captures the routePattern as a literal string', async () => {
    batch = await extract('basic', 'src/server.ts');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:id');
    expect(patterns).toContain('/catch-all');
  });

  it('uppercases the HTTP method on every endpoint', async () => {
    batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.httpMethod).toBe(ep.httpMethod.toUpperCase());
    }
  });

  it('sets framework="koa" on every endpoint', async () => {
    batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('koa');
  });

  it('detects named routes (router.get("name", "/path", handler))', async () => {
    batch = await extract('basic', 'src/server.ts');
    const detail = endpoints(batch).find((e) => e.routePattern === '/users/:id/detail');
    expect(detail).toBeDefined();
    expect(detail!.httpMethod).toBe('GET');
  });

  it('treats middleware before the handler as middleware, not the handler', async () => {
    batch = await extract('basic', 'src/server.ts');
    const del = endpoints(batch).find((e) => e.httpMethod === 'DELETE' && e.routePattern === '/users/:id');
    expect(del).toBeDefined();
    // Inline arrow at the end is the handler — handlerFunctionId should be null.
    expect(del!.handlerFunctionId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Handler resolution
// ──────────────────────────────────────────────────────────────────────

describe('handler resolution', () => {
  it('resolves a same-file function-declaration handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const listEndpoint = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/users'
    );
    expect(listEndpoint).toBeDefined();
    expect(listEndpoint!.handlerFunctionId).not.toBeNull();

    const listUsersFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'listUsers'
    );
    expect(listUsersFn).toBeDefined();
    expect(listEndpoint!.handlerFunctionId).toBe(listUsersFn!.id);
  });

  it('resolves a same-file variable-bound arrow handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const getByIdEndpoint = endpoints(batch).find(
      (e) => e.httpMethod === 'GET' && e.routePattern === '/users/:id'
    );
    expect(getByIdEndpoint).toBeDefined();
    expect(getByIdEndpoint!.handlerFunctionId).not.toBeNull();
    const getUserByIdFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'getUserById'
    );
    expect(getUserByIdFn).toBeDefined();
    expect(getByIdEndpoint!.handlerFunctionId).toBe(getUserByIdFn!.id);
  });

  it('returns null for an inline arrow handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const post = endpoints(batch).find(
      (e) => e.httpMethod === 'POST' && e.routePattern === '/users'
    );
    expect(post).toBeDefined();
    expect(post!.handlerFunctionId).toBeNull();
  });

  it('resolves a cross-file imported handler', async () => {
    const batch = await extract('basic', 'src/cross-file.ts');
    const health = endpoints(batch).find((e) => e.routePattern === '/health');
    expect(health).toBeDefined();
    expect(health!.handlerFunctionId).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('skips receivers that do not match the router heuristic', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const eps = endpoints(batch);
    expect(eps.find((e) => e.routePattern === '/wont-match')).toBeUndefined();
  });

  it('negatives.ts should emit zero endpoints', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    expect(endpoints(batch)).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('emits paths with multiple :param segments verbatim', async () => {
    const batch = await extract('basic', 'src/edge-cases.ts');
    expect(endpoints(batch).map((e) => e.routePattern)).toContain('/users/:id/posts/:postId');
  });

  it('emits an endpoint for an empty-string path', async () => {
    const batch = await extract('basic', 'src/edge-cases.ts');
    expect(endpoints(batch).map((e) => e.routePattern)).toContain('');
  });

  it('same (method, path) declared on different lines produces distinct ids (#185)', async () => {
    // Pre-#185 the id collapsed both declarations into one node;
    // post-#185 filePath + lineStart in the id derivation preserve
    // them as distinct endpoints.
    const batch = await extract('basic', 'src/edge-cases.ts');
    const dups = endpoints(batch).filter((e) => e.routePattern === '/dup');
    expect(dups.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(dups.map((e) => e.id));
    expect(ids.size).toBe(dups.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('KoaPlugin contract', () => {
  it('has id="koa" and language="ts"', () => {
    const plugin = new KoaPlugin();
    expect(plugin.id).toBe('koa');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when koa is a dependency', () => {
    const plugin = new KoaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { koa: '^2.0.0', '@koa/router': '^12.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true when koa-router is a dependency', () => {
    const plugin = new KoaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { 'koa-router': '^10.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Koa project', () => {
    const plugin = new KoaPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      })
    ).toBe(false);
  });

  it('visitor identity is stable across accesses', () => {
    const plugin = new KoaPlugin();
    expect(plugin.visitor).toBe(plugin.visitor);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: commit to the canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly and round-trip via findNodes', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const koa = new KoaPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(koa.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of ['src/server.ts', 'src/cross-file.ts', 'src/handlers.ts']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('koa');
      }
    } finally {
      store.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Round 7 — Koa server-side render: ctx.render(...)
// ──────────────────────────────────────────────────────────────────────

function screens(batch: { nodes: SchemaNode[] }): Screen[] {
  return batch.nodes.filter((n): n is Screen => n.nodeType === 'Screen');
}

function rendersEdges(batch: { edges: SchemaEdge[] }): RendersEdge[] {
  return batch.edges.filter((e): e is RendersEdge => e.edgeType === 'RENDERS');
}

describe('koa ctx.render() → Screen + RENDERS edge', () => {
  it('emits a Screen node per ctx.render() call site', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const names = screens(batch).map((s) => s.name).sort();
    expect(names).toContain('auth/signin');
    expect(names).toContain('account/dashboard');
  });

  it('emits a RENDERS edge from each APIEndpoint to its Screen', async () => {
    const batch = await extract('basic', 'src/render.ts');
    const edges = rendersEdges(batch);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.every((e) => typeof e.templateName === 'string')).toBe(true);
  });

  it('Screen.framework is "koa-ssr" for koa-emitted screens', async () => {
    const batch = await extract('basic', 'src/render.ts');
    for (const s of screens(batch)) {
      expect(s.framework).toBe('koa-ssr');
    }
  });
});
