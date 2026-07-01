import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateNode, type APIEndpoint, type SchemaNode } from '@adorable/schema';
import { makeBatchMeta, type NodeBatch } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { GraphqlPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/graphql');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const graphql = new GraphqlPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(graphql.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function endpoints(batch: { nodes: SchemaNode[] }): APIEndpoint[] {
  return batch.nodes.filter((n): n is APIEndpoint => n.nodeType === 'APIEndpoint');
}

// ──────────────────────────────────────────────────────────────────────
// Standard resolver map: Query + Mutation + Subscription
// ──────────────────────────────────────────────────────────────────────

describe('standard resolver map', () => {
  it('emits one endpoint per resolver under each GraphQL type', async () => {
    const batch = await extract('basic', 'src/standard-resolvers.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern).sort();
    expect(patterns).toEqual([
      '/graphql/Mutation/createUser',
      '/graphql/Query/user',
      '/graphql/Query/users',
      '/graphql/Subscription/userUpdated',
    ]);
  });

  it('maps Query → GET, Mutation → POST, Subscription → WS', async () => {
    const batch = await extract('basic', 'src/standard-resolvers.ts');
    const byPath = Object.fromEntries(endpoints(batch).map((e) => [e.routePattern, e.httpMethod]));
    expect(byPath['/graphql/Query/users']).toBe('GET');
    expect(byPath['/graphql/Query/user']).toBe('GET');
    expect(byPath['/graphql/Mutation/createUser']).toBe('POST');
    expect(byPath['/graphql/Subscription/userUpdated']).toBe('WS');
  });

  it('sets framework="graphql" on every endpoint', async () => {
    const batch = await extract('basic', 'src/standard-resolvers.ts');
    for (const ep of endpoints(batch)) expect(ep.framework).toBe('graphql');
  });

  it('every emitted endpoint passes canonical schema validation', async () => {
    const batch = await extract('basic', 'src/standard-resolvers.ts');
    const eps = endpoints(batch);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) expect(() => validateNode(ep)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Resolver property shapes — all three accepted forms
// ──────────────────────────────────────────────────────────────────────

describe('resolver property shapes', () => {
  it('resolves handlerFunctionId for property-assigned arrow functions', async () => {
    const batch = await extract('basic', 'src/property-shapes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/inline');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  it('resolves handlerFunctionId for property-assigned function expressions', async () => {
    const batch = await extract('basic', 'src/property-shapes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/inlineFnExpr');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  it('resolves handlerFunctionId for method declarations', async () => {
    const batch = await extract('basic', 'src/property-shapes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/methodDecl');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  // #202 fixed: Identifier-valued PropertyAssignment now resolves
  // through the cross-file helper from #200.
  it('Identifier-valued resolver resolves to a non-null handlerFunctionId (#202)', async () => {
    const batch = await extract('basic', 'src/property-shapes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/identifierResolver');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });

  // #202 fixed: shorthand `{ users }` resolves the same way.
  it('shorthand property resolves to a non-null handlerFunctionId (#202)', async () => {
    const batch = await extract('basic', 'src/property-shapes.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/usersResolver');
    expect(ep).toBeDefined();
    expect(ep!.handlerFunctionId).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Anti-false-positive heuristics
// ──────────────────────────────────────────────────────────────────────

describe('anti-false-positive heuristics', () => {
  // CASE A — single GraphQL type sibling, enclosing variable name contains "resolver".
  it('matches a single-Query map when the variable name contains "resolver"', async () => {
    const batch = await extract('basic', 'src/heuristics.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/users');
    expect(ep).toBeDefined();
  });

  // CASE B — single GraphQL type sibling, enclosing variable name unrelated → skip.
  it('does NOT match a single-Query map whose name has nothing resolver-like (Redux-store guard)', async () => {
    const batch = await extract('basic', 'src/heuristics.ts');
    // userSlice = { Query: { pendingFetches: 0 } } — must NOT emit.
    expect(endpoints(batch).find((e) => e.routePattern === '/graphql/Query/pendingFetches')).toBeUndefined();
  });

  // CASE C — single Query type nested under property named "resolvers".
  it('matches a single-Query map nested under a property named "resolvers"', async () => {
    const batch = await extract('basic', 'src/heuristics.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Query/products');
    expect(ep).toBeDefined();
  });

  // CASE D — multi-type sibling (Query + Mutation) passes the guard directly.
  it('matches a multi-type map regardless of enclosing variable name', async () => {
    const batch = await extract('basic', 'src/heuristics.ts');
    const eps = endpoints(batch).filter((e) =>
      e.routePattern === '/graphql/Query/health' || e.routePattern === '/graphql/Mutation/ping',
    );
    expect(eps).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Identifier-valued type values — pin for #200 cross-file resolution
// ──────────────────────────────────────────────────────────────────────

describe('Identifier-valued type values (cross-file split — #202 fix)', () => {
  // #202 fixed: when `Query: queryResolvers` references an imported
  // resolver map, the visitor follows the Identifier cross-file via
  // `resolveIdentifierTypeToDeclaration` from #200 and continues the
  // resolver-property walk on the target ObjectLiteral.

  it('Identifier-valued Query emits one endpoint per resolver (#202)', async () => {
    const batch = await extract('basic', 'src/cross-file-types.ts');
    const patterns = endpoints(batch).map((e) => e.routePattern);
    // queryResolvers in cross-file-query.ts declares `users` + `user`.
    expect(patterns).toContain('/graphql/Query/users');
    expect(patterns).toContain('/graphql/Query/user');
  });

  it('still emits siblings whose type value IS an inline ObjectLiteral', async () => {
    const batch = await extract('basic', 'src/cross-file-types.ts');
    const ep = endpoints(batch).find((e) => e.routePattern === '/graphql/Mutation/createUser');
    expect(ep).toBeDefined();
    expect(ep!.httpMethod).toBe('POST');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negatives
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('emits zero endpoints for a Redux-style store keyed on Query', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    // negatives.ts contains 3 Redux-style shapes; none should match.
    expect(endpoints(batch)).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('GraphqlPlugin contract', () => {
  it('has id="graphql" and language="ts"', () => {
    const plugin = new GraphqlPlugin();
    expect(plugin.id).toBe('graphql');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true when graphql is a dependency', () => {
    const plugin = new GraphqlPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { graphql: '^16.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for a non-GraphQL project', () => {
    const plugin = new GraphqlPlugin();
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
    const batch = await extract('basic', 'src/standard-resolvers.ts');
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
      const graphql = new GraphqlPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(graphql.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      for (const file of [
        'src/standard-resolvers.ts',
        'src/property-shapes.ts',
        'src/heuristics.ts',
      ]) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allEndpoints = store.findNodes('APIEndpoint');
      expect(allEndpoints.length).toBeGreaterThan(0);
      for (const ep of allEndpoints) {
        expect(ep.framework).toBe('graphql');
      }
    } finally {
      store.close();
    }
  });
});
