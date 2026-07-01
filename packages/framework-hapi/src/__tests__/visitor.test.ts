import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { HapiPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/hapi');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const hapi = new HapiPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(hapi.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// Canonical server.route() detection
// ──────────────────────────────────────────────────────────────────────

describe('canonical hapi server.route() detection', () => {
  let batch: NodeBatch;

  it('every emitted endpoint passes canonical schema validation', async () => {
    batch = await extract('basic', 'src/server.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(() => validateNode(ep)).not.toThrow();
  });

  it('detects single route object declarations', async () => {
    batch = await extract('basic', 'src/server.ts');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:userId');
  });

  it('detects array of route objects', async () => {
    batch = await extract('basic', 'src/server.ts');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns).toContain('/health');
    expect(patterns).toContain('/version');
  });

  it('expands multi-method routes into separate endpoints', async () => {
    batch = await extract('basic', 'src/server.ts');
    const multiEndpoints = endpoints(batch).filter((e) => e.routePattern === '/multi');
    expect(multiEndpoints.map((e) => e.httpMethod).sort()).toEqual(['GET', 'POST']);
  });

  it('normalizes Hapi {param} syntax to :param', async () => {
    batch = await extract('basic', 'src/server.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    // {userId} → :userId
    expect(patterns).toContain('/users/:userId');
    // {itemId} and {reviewId}
    expect(patterns).toContain('/items/:itemId/reviews/:reviewId');
  });

  it('uppercases the HTTP method on every endpoint', async () => {
    batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.httpMethod).toBe(ep.httpMethod.toUpperCase());
    }
  });

  it('sets framework="hapi" on every endpoint', async () => {
    batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('hapi');
  });

  it('detects all standard HTTP verbs', async () => {
    batch = await extract('basic', 'src/server.ts');
    const methods = new Set(endpoints(batch).map((e) => e.httpMethod));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
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
      (e) => e.httpMethod === 'GET' && e.routePattern === '/users/:userId'
    );
    expect(getByIdEndpoint).toBeDefined();
    expect(getByIdEndpoint!.handlerFunctionId).not.toBeNull();
    const getUserByIdFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && n.name === 'getUserById'
    );
    expect(getUserByIdFn).toBeDefined();
    expect(getByIdEndpoint!.handlerFunctionId).toBe(getUserByIdFn!.id);
  });

  it('returns null for an inline handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const post = endpoints(batch).find(
      (e) => e.httpMethod === 'POST' && e.routePattern === '/users'
    );
    expect(post).toBeDefined();
    expect(post!.handlerFunctionId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('skips receivers that do not match the server heuristic', async () => {
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
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('HapiPlugin contract', () => {
  it('has id="hapi" and language="ts"', () => {
    const plugin = new HapiPlugin();
    expect(plugin.id).toBe('hapi');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when @hapi/hapi is a dependency', () => {
    const plugin = new HapiPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@hapi/hapi': '^21.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Hapi project', () => {
    const plugin = new HapiPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      })
    ).toBe(false);
  });

  it('visitor identity is stable across accesses', () => {
    const plugin = new HapiPlugin();
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
      const hapi = new HapiPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(hapi.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      const batch = await ts.extractFile(handle, 'src/server.ts');
      store.commit(batch, makeBatchMeta('ts'));

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('hapi');
      }
    } finally {
      store.close();
    }
  });
});
