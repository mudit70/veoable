import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { TrpcPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/trpc');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const trpc = new TrpcPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(trpc.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// Flat router shape (the canonical case)
// ──────────────────────────────────────────────────────────────────────

describe('flat router with bare `router({...})`', () => {
  it('emits one endpoint per top-level procedure', async () => {
    const batch = await extract('basic', 'src/flat-router.ts');
    const eps = endpoints(batch);
    expect(eps).toHaveLength(3);
    expect(eps.map((e) => e.routePattern).sort()).toEqual([
      '/trpc/createUser',
      '/trpc/getUser',
      '/trpc/watchUser',
    ]);
  });

  it('derives HTTP method from the last call in the chain', async () => {
    const batch = await extract('basic', 'src/flat-router.ts');
    const byPath = Object.fromEntries(endpoints(batch).map((e) => [e.routePattern, e.httpMethod]));
    expect(byPath['/trpc/getUser']).toBe('GET');
    expect(byPath['/trpc/createUser']).toBe('POST');
    expect(byPath['/trpc/watchUser']).toBe('WS');
  });

  it('sets framework="trpc" on every endpoint', async () => {
    const batch = await extract('basic', 'src/flat-router.ts');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('trpc');
  });

  it('every emitted endpoint passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/flat-router.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(() => validateNode(ep)).not.toThrow();
  });

  it('resolves handlerFunctionId for inline arrow handlers', async () => {
    const batch = await extract('basic', 'src/flat-router.ts');
    for (const ep of endpoints(batch)) {
      expect(ep.handlerFunctionId).not.toBeNull();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Three router-call entry shapes
// ──────────────────────────────────────────────────────────────────────

describe('router-call entry shapes', () => {
  it('matches `t.router({...})` (property-access whose name is `router`)', async () => {
    const batch = await extract('basic', 'src/entry-shapes.ts');
    const greet = endpoints(batch).find((e) => e.routePattern === '/trpc/greet');
    expect(greet).toBeDefined();
    expect(greet!.httpMethod).toBe('GET');
  });

  it('matches `createTRPCRouter({...})` (bare identifier)', async () => {
    const batch = await extract('basic', 'src/entry-shapes.ts');
    const ping = endpoints(batch).find((e) => e.routePattern === '/trpc/ping');
    expect(ping).toBeDefined();
    expect(ping!.httpMethod).toBe('GET');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Nested routers — prefix flattening + the cross-file gap pin
// ──────────────────────────────────────────────────────────────────────

describe('nested routers', () => {
  it('flattens an inline-nested router into `parent.child` paths', async () => {
    const batch = await extract('basic', 'src/nested-router.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).toContain('/trpc/users.list');
    expect(patterns).toContain('/trpc/users.create');
  });

  it('inline-nested children carry the right HTTP method', async () => {
    const batch = await extract('basic', 'src/nested-router.ts');
    const list = endpoints(batch).find((e) => e.routePattern === '/trpc/users.list');
    const create = endpoints(batch).find((e) => e.routePattern === '/trpc/users.create');
    expect(list!.httpMethod).toBe('GET');
    expect(create!.httpMethod).toBe('POST');
  });

  // #201 fixed: Identifier-valued nested routers now recurse via the
  // `resolveIdentifierTypeToDeclaration` helper from #200. The fixture
  // has TWO `users.*` mounts in the same file (inlineNested.users.* and
  // referencedNested.users.* via the Identifier `usersRouter`), so the
  // routePattern collisions de-dupe by (filePath,lineStart) — each
  // emit gets a distinct id.
  it('Identifier-valued nested router resolves and emits `users.*` endpoints (#201)', async () => {
    const batch = await extract('basic', 'src/nested-router.ts');
    const userListEndpoints = endpoints(batch).filter((e) => e.routePattern === '/trpc/users.list');
    const userCreateEndpoints = endpoints(batch).filter((e) => e.routePattern === '/trpc/users.create');
    expect(userListEndpoints.length).toBeGreaterThanOrEqual(2);
    expect(userCreateEndpoints.length).toBeGreaterThanOrEqual(2);
    // The two mounts (inline-nested and Identifier-referenced) must
    // produce distinct ids — the (filePath,lineStart) tuple in the
    // APIEndpoint id discriminates them.
    const listIds = new Set(userListEndpoints.map((e) => e.id));
    expect(listIds.size).toBe(userListEndpoints.length);
  });

  it('siblings of an Identifier-nested entry still resolve normally', async () => {
    const batch = await extract('basic', 'src/nested-router.ts');
    const postsList = endpoints(batch).find((e) => e.routePattern === '/trpc/posts.list');
    expect(postsList).toBeDefined();
  });

  it('mounting the SAME router under two prefixes emits both sets (#201)', async () => {
    const batch = await extract('basic', 'src/nested-router.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    expect(patterns).toContain('/trpc/v1.list');
    expect(patterns).toContain('/trpc/v1.create');
    expect(patterns).toContain('/trpc/v2.list');
    expect(patterns).toContain('/trpc/v2.create');
  });

  it('resolves an Identifier-valued nested router declared in ANOTHER file (#201)', async () => {
    const batch = await extract('basic', 'src/cross-file-app.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    expect(patterns).toContain('/trpc/users.list');
    expect(patterns).toContain('/trpc/users.create');
    // Sibling inline procedure still works.
    expect(patterns).toContain('/trpc/health');

    // The cross-file procedures' handlerFunctionId must NOT be keyed
    // to the mount file's SourceFile id — that would never match the
    // FunctionDefinition the language plugin emits when it processes
    // `cross-file-users.ts` independently.
    const usersList = endpoints(batch).find((e) => e.routePattern === '/trpc/users.list');
    expect(usersList).toBeDefined();
    expect(usersList!.handlerFunctionId).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Chained builder — .input().output().query() etc.
// ──────────────────────────────────────────────────────────────────────

describe('chained procedure builder', () => {
  it('walks .input(...).query(handler) chains and finds the procedure type', async () => {
    const batch = await extract('basic', 'src/chained-builder.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/inputThenQuery');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('GET');
  });

  it('walks .output(...).query(handler) chains', async () => {
    const batch = await extract('basic', 'src/chained-builder.ts');
    expect(endpoints(batch).find((e) => e.routePattern === '/trpc/outputThenQuery')).toBeDefined();
  });

  it('walks full .input(...).output(...).query(handler) chains', async () => {
    const batch = await extract('basic', 'src/chained-builder.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/fullChainQuery');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('GET');
  });

  it('walks chains ending in .mutation(handler) and emits POST', async () => {
    const batch = await extract('basic', 'src/chained-builder.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/fullChainMutation');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('POST');
  });

  it('walks chains ending in .subscription(handler) and emits WS', async () => {
    const batch = await extract('basic', 'src/chained-builder.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/chainSubscription');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('WS');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Handler resolution — pin current behavior including #201 gap
// ──────────────────────────────────────────────────────────────────────

describe('handler resolution', () => {
  it('resolves handlerFunctionId for inline arrow handlers', async () => {
    const batch = await extract('basic', 'src/handler-resolution.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/inline');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  it('resolves handlerFunctionId for inline function expression handlers', async () => {
    const batch = await extract('basic', 'src/handler-resolution.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/inlineFnExpr');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  // Pins #201: the `resolveHandler` check at visitor.ts:139 only matches
  // ArrowFunction / FunctionExpression. Identifier-valued handlers
  // (the idiomatic shape — handler defined as a named function and
  // referenced) emit the endpoint but with handlerFunctionId null. When
  // #201 lands these tests will need to flip.
  it('pins #201: Identifier-valued handler emits endpoint with handlerFunctionId null', async () => {
    const batch = await extract('basic', 'src/handler-resolution.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/identifierHandler');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).toBeNull();
  });

  it('pins #201: variable-bound arrow referenced by Identifier emits endpoint with handlerFunctionId null', async () => {
    const batch = await extract('basic', 'src/handler-resolution.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/trpc/arrowConstAsIdentifier');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negatives
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('does not emit endpoints from `useRouter()` calls', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    // useRouter is a property-access via push, not a router call. No /trpc paths
    // should originate from useRouter scope — assert no /trpc/push exists.
    expect(endpoints(batch).find((e) => e.routePattern === '/trpc/push')).toBeUndefined();
  });

  it('emits no endpoints when `router(...)` is called with a non-ObjectLiteral arg', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    // negatives.ts contains `router(someConfig)` where someConfig is a
    // plain Identifier. The visitor's first-arg-must-be-object-literal
    // gate skips it. The only emissions from this file should be the
    // ones from `notTrpc.router('hello')` — also non-object — and the
    // empty router (zero procedures). Assert: zero endpoints total.
    expect(endpoints(batch)).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('TrpcPlugin contract', () => {
  it('has id="trpc" and language="ts"', () => {
    const plugin = new TrpcPlugin();
    expect(plugin.id).toBe('trpc');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when @trpc/server is a dependency', () => {
    const plugin = new TrpcPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@trpc/server': '^10.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true when @trpc/react-query is a dependency', () => {
    const plugin = new TrpcPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@trpc/react-query': '^10.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-tRPC project', () => {
    const plugin = new TrpcPlugin();
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
// Endpoint id content-addressing
// ──────────────────────────────────────────────────────────────────────

describe('endpoint id content-addressing', () => {
  it('distinct (method, path) pairs produce distinct ids', async () => {
    const batch = await extract('basic', 'src/flat-router.ts');
    const ids = new Set(endpoints(batch).map((e) => e.id));
    expect(ids.size).toBe(endpoints(batch).length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end with canonical store
// ──────────────────────────────────────────────────────────────────────

describe('end-to-end with canonical store', () => {
  it('endpoints commit cleanly and round-trip via findNodes', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const trpc = new TrpcPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(trpc.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of [
        'src/flat-router.ts',
        'src/entry-shapes.ts',
        'src/nested-router.ts',
        'src/chained-builder.ts',
        'src/handler-resolution.ts',
      ]) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('trpc');
      }
    } finally {
      store.close();
    }
  });
});
