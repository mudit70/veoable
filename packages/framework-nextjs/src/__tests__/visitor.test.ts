import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { NextjsPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/nextjs');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const nextjs = new NextjsPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(nextjs.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// App Router route.ts detection
// ──────────────────────────────────────────────────────────────────────

describe('app router route.ts detection', () => {
  it('detects GET and POST in app/api/users/route.ts', async () => {
    const batch = await extract('basic', 'app/api/users/route.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBe(2);
    const methods = eps.map((e) => e.httpMethod).sort();
    expect(methods).toEqual(['GET', 'POST']);
    for (const ep of eps) {
      expect(ep.routePattern).toBe('/api/users');
      expect(ep.framework).toBe('nextjs');
    }
  });

  it('detects dynamic segment routes', async () => {
    const batch = await extract('basic', 'app/api/users/[id]/route.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBe(2);
    for (const ep of eps) {
      expect(ep.routePattern).toBe('/api/users/:id');
    }
  });

  it('resolves handler function ids', async () => {
    const batch = await extract('basic', 'app/api/users/route.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.handlerFunctionId).not.toBeNull();
    }
  });

  it('every endpoint passes schema validation', async () => {
    const batch = await extract('basic', 'app/api/users/route.ts');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pages Router API route detection
// ──────────────────────────────────────────────────────────────────────

describe('pages router API route detection', () => {
  it('detects default export as ALL endpoint', async () => {
    const batch = await extract('basic', 'pages/api/legacy.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBe(1);
    expect(eps[0].httpMethod).toBe('ALL');
    expect(eps[0].routePattern).toBe('/api/legacy');
    expect(eps[0].handlerFunctionId).not.toBeNull();
  });

  // #327 — files prefixed `_` are private helpers, not routes. cal.com
  // uses `_get.ts`/`_post.ts`/`_auth-middleware.ts`/`_utils/...ts`
  // extensively; pre-fix every one was emitted as a fake `ALL` endpoint.
  it('skips _-prefixed files in pages/api/ (cal.com convention)', async () => {
    for (const file of ['pages/api/_get.ts', 'pages/api/_auth-middleware.ts']) {
      const batch = await extract('basic', file);
      const eps = endpoints(batch);
      expect(eps.length).toBe(0);
    }
  });

  it('skips files inside _-prefixed directories in pages/api/', async () => {
    const batch = await extract('basic', 'pages/api/_utils/checkOwnership.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Medusa.js v2 file-based router (#328)
// ──────────────────────────────────────────────────────────────────────

describe('Medusa router detection (#328)', () => {
  it('detects export const GET/POST in api/<segments>/route.ts (no app/ prefix)', async () => {
    const batch = await extract('basic', 'api/admin/orders/route.ts');
    const eps = endpoints(batch);
    const patterns = new Set(eps.map((e) => `${e.httpMethod} ${e.routePattern}`));
    expect(patterns).toContain('GET /admin/orders');
    expect(patterns).toContain('POST /admin/orders');
  });

  it('translates dynamic segments [actor_type] → :actor_type', async () => {
    const batch = await extract('basic', 'api/auth/[actor_type]/[auth_provider]/route.ts');
    const eps = endpoints(batch);
    const patterns = new Set(eps.map((e) => `${e.httpMethod} ${e.routePattern}`));
    expect(patterns).toContain('POST /auth/:actor_type/:auth_provider');
  });

  it('emits framework="medusa" (not "nextjs") for Medusa routes', async () => {
    const batch = await extract('basic', 'api/admin/orders/route.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(1);
    for (const e of eps) {
      expect(e.framework).toBe('medusa');
    }
  });

  it('emits framework="nextjs" for genuine App Router routes (regression guard for #336)', async () => {
    const batch = await extract('basic', 'app/api/users/route.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThanOrEqual(1);
    for (const e of eps) {
      expect(e.framework).toBe('nextjs');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Server Actions (#60)
// ──────────────────────────────────────────────────────────────────────

describe('server actions detection (#60)', () => {
  it('detects exported functions in "use server" files as POST endpoints', async () => {
    const batch = await extract('basic', 'app/actions/user-actions.ts');
    const eps = endpoints(batch);
    // createUser and deleteUser should be detected, but not validateUser (not exported)
    expect(eps.length).toBe(2);
    for (const ep of eps) {
      expect(ep.httpMethod).toBe('POST');
      expect(ep.framework).toBe('nextjs');
    }
  });

  it('uses /_server-action/ route pattern for server actions', async () => {
    const batch = await extract('basic', 'app/actions/user-actions.ts');
    const eps = endpoints(batch);
    const patterns = eps.map((e) => e.routePattern).sort();
    expect(patterns).toContain('/_server-action/actions/user-actions/createUser');
    expect(patterns).toContain('/_server-action/actions/user-actions/deleteUser');
  });

  it('resolves handler function ids for server actions', async () => {
    const batch = await extract('basic', 'app/actions/user-actions.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.handlerFunctionId).not.toBeNull();
    }
  });

  it('does not detect non-exported functions', async () => {
    const batch = await extract('basic', 'app/actions/user-actions.ts');
    const eps = endpoints(batch);
    const names = eps.map((e) => e.routePattern);
    expect(names.find((n) => n.includes('validateUser'))).toBeUndefined();
  });

  it('every server action endpoint passes schema validation', async () => {
    const batch = await extract('basic', 'app/actions/user-actions.ts');
    for (const ep of endpoints(batch)) {
      expect(() => validateNode(ep)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('NextjsPlugin contract', () => {
  it('has id="nextjs" and language="ts"', () => {
    const plugin = new NextjsPlugin();
    expect(plugin.id).toBe('nextjs');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when next is a dependency', () => {
    const plugin = new NextjsPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { next: '^14.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-Next.js project', () => {
    const plugin = new NextjsPlugin();
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
  it('all endpoints commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const nextjs = new NextjsPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(nextjs.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      const files = [
        'app/api/users/route.ts',
        'app/api/users/[id]/route.ts',
        'app/actions/user-actions.ts',
        'pages/api/legacy.ts',
      ];

      for (const file of files) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('nextjs');
      }
    } finally {
      store.close();
    }
  });
});
