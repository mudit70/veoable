import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { HonoPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/hono');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const hono = new HonoPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(hono.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

describe('canonical hono route detection', () => {
  it('every emitted endpoint passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(() => validateNode(ep)).not.toThrow();
  });

  it('detects every standard verb at least once', async () => {
    const batch = await extract('basic', 'src/server.ts');
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

  it('captures route patterns', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const patterns = new Set(endpoints(batch).map((e) => e.routePattern));
    expect(patterns).toContain('/users');
    expect(patterns).toContain('/users/:id');
    expect(patterns).toContain('/catch-all');
  });

  it('sets framework="hono"', async () => {
    const batch = await extract('basic', 'src/server.ts');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('hono');
  });
});

describe('handler resolution', () => {
  it('resolves same-file function-declaration handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find((e) => e.httpMethod === 'GET' && e.routePattern === '/users');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  it('resolves same-file variable-bound arrow handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find((e) => e.httpMethod === 'GET' && e.routePattern === '/users/:id');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  it('returns null for inline handler', async () => {
    const batch = await extract('basic', 'src/server.ts');
    const ep = endpoints(batch).find((e) => e.httpMethod === 'POST' && e.routePattern === '/users');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).toBeNull();
  });

  it('resolves cross-file handler', async () => {
    const batch = await extract('basic', 'src/cross-file.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/health');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });
});

describe('negative cases', () => {
  it('skips non-canonical receivers', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    expect(endpoints(batch)).toHaveLength(0);
  });
});

describe('HonoPlugin contract', () => {
  it('has id="hono" and language="ts"', () => {
    const plugin = new HonoPlugin();
    expect(plugin.id).toBe('hono');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when hono is a dependency', () => {
    const plugin = new HonoPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { hono: '^4.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Hono project', () => {
    const plugin = new HonoPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      })
    ).toBe(false);
  });
});

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly and round-trip via findNodes', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const hono = new HonoPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(hono.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of ['src/server.ts', 'src/cross-file.ts']) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('hono');
      }
    } finally {
      store.close();
    }
  });
});
