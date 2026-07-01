import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { RemixPlugin } from '../index.js';
import { filePathToRoutePattern } from '../route-convention.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/remix');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const remix = new RemixPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(remix.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// Route convention parser
// ──────────────────────────────────────────────────────────────────────

describe('filePathToRoutePattern', () => {
  it('converts simple route', () => {
    expect(filePathToRoutePattern('app/routes/users.tsx')).toBe('/users');
  });

  it('converts nested route with dot separator', () => {
    expect(filePathToRoutePattern('app/routes/api.health.tsx')).toBe('/api/health');
  });

  it('converts dynamic segment', () => {
    expect(filePathToRoutePattern('app/routes/users.$id.tsx')).toBe('/users/:id');
  });

  it('strips pathless layout prefix', () => {
    expect(filePathToRoutePattern('app/routes/_auth.login.tsx')).toBe('/login');
  });

  it('converts _index to root', () => {
    expect(filePathToRoutePattern('app/routes/_index.tsx')).toBe('/');
  });

  it('converts nested _index', () => {
    expect(filePathToRoutePattern('app/routes/users._index.tsx')).toBe('/users');
  });

  it('converts splat route', () => {
    expect(filePathToRoutePattern('app/routes/files.$.tsx')).toBe('/files/*');
  });

  it('returns null for non-route files', () => {
    expect(filePathToRoutePattern('src/server.ts')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Remix route detection
// ──────────────────────────────────────────────────────────────────────

describe('remix route detection', () => {
  it('detects exported loader as GET endpoint', async () => {
    const batch = await extract('basic', 'app/routes/users.tsx');
    const eps = endpoints(batch);
    const getEndpoint = eps.find((e) => e.httpMethod === 'GET');
    expect(getEndpoint).toBeDefined();
    expect(getEndpoint!.routePattern).toBe('/users');
    expect(getEndpoint!.framework).toBe('remix');
  });

  it('detects exported action as POST endpoint', async () => {
    const batch = await extract('basic', 'app/routes/users.tsx');
    const eps = endpoints(batch);
    const postEndpoint = eps.find((e) => e.httpMethod === 'POST');
    expect(postEndpoint).toBeDefined();
    expect(postEndpoint!.routePattern).toBe('/users');
  });

  it('detects dynamic segment route', async () => {
    const batch = await extract('basic', 'app/routes/users.$id.tsx');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    expect(eps[0].routePattern).toBe('/users/:id');
  });

  it('detects nested API route', async () => {
    const batch = await extract('basic', 'app/routes/api.health.tsx');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    expect(eps[0].routePattern).toBe('/api/health');
    expect(eps[0].httpMethod).toBe('GET');
  });

  it('strips pathless layout prefix', async () => {
    const batch = await extract('basic', 'app/routes/_auth.login.tsx');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    expect(eps[0].routePattern).toBe('/login');
  });

  it('detects index route', async () => {
    const batch = await extract('basic', 'app/routes/_index.tsx');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    expect(eps[0].routePattern).toBe('/');
    expect(eps[0].httpMethod).toBe('GET');
  });

  it('every emitted endpoint passes schema validation', async () => {
    const batch = await extract('basic', 'app/routes/users.tsx');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });

  it('resolves handler function id for function declaration loaders', async () => {
    const batch = await extract('basic', 'app/routes/users.tsx');
    const getEndpoint = endpoints(batch).find((e) => e.httpMethod === 'GET');
    expect(getEndpoint).toBeDefined();
    expect(getEndpoint!.handlerFunctionId).not.toBeNull();
  });

  it('resolves handler function id for arrow function actions', async () => {
    const batch = await extract('basic', 'app/routes/_auth.login.tsx');
    const postEndpoint = endpoints(batch).find((e) => e.httpMethod === 'POST');
    expect(postEndpoint).toBeDefined();
    expect(postEndpoint!.handlerFunctionId).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('RemixPlugin contract', () => {
  it('has id="remix" and language="ts"', () => {
    const plugin = new RemixPlugin();
    expect(plugin.id).toBe('remix');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when @remix-run/node is a dependency', () => {
    const plugin = new RemixPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@remix-run/node': '^2.0.0', '@remix-run/react': '^2.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Remix project', () => {
    const plugin = new RemixPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { express: '^4.0.0' } },
        files: [],
      })
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('all route endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const remix = new RemixPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(remix.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      const routeFiles = [
        'app/routes/users.tsx',
        'app/routes/users.$id.tsx',
        'app/routes/api.health.tsx',
        'app/routes/_auth.login.tsx',
        'app/routes/_index.tsx',
      ];

      for (const file of routeFiles) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('remix');
      }
    } finally {
      store.close();
    }
  });
});
