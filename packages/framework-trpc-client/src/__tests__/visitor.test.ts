import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type ClientSideAPICaller,
  type SchemaNode,
  type SchemaEdge,
} from '@adorable/schema';
import { type NodeBatch } from '@adorable/plugin-api';
import { TsLanguagePlugin } from '@adorable/lang-ts';
import { TrpcClientPlugin } from '../trpc-client-plugin.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/trpc-client');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const trpc = new TrpcClientPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(trpc.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function callers(batch: { nodes: SchemaNode[] }): ClientSideAPICaller[] {
  return batch.nodes.filter(
    (n): n is ClientSideAPICaller => n.nodeType === 'ClientSideAPICaller',
  );
}
function edgesOfType(batch: { edges: SchemaEdge[] }, t: string): SchemaEdge[] {
  return batch.edges.filter((e) => e.edgeType === t);
}

describe('trpc-client visitor — caller emission', () => {
  it('emits ClientSideAPICaller for useQuery (GET)', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    const list = callers(batch).find((c) => c.urlLiteral === '/trpc/users.list');
    expect(list).toBeDefined();
    expect(list!.httpMethod).toBe('GET');
    expect(list!.framework).toBe('trpc-client');
  });

  it('emits ClientSideAPICaller for useMutation (POST)', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    const create = callers(batch).find((c) => c.urlLiteral === '/trpc/users.create');
    expect(create).toBeDefined();
    expect(create!.httpMethod).toBe('POST');
  });

  it('emits ClientSideAPICaller for deeply-nested path', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    const byId = callers(batch).find((c) => c.urlLiteral === '/trpc/admin.users.byId');
    expect(byId).toBeDefined();
    expect(byId!.httpMethod).toBe('GET');
  });

  it('emits ClientSideAPICaller for vanilla query (GET)', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    const get = callers(batch).find((c) => c.urlLiteral === '/trpc/users.get');
    expect(get).toBeDefined();
    expect(get!.httpMethod).toBe('GET');
  });

  it('emits ClientSideAPICaller for vanilla mutate (POST)', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    // `users.create` appears for BOTH the hook and the vanilla mutate
    // — but they share urlLiteral. Each call site emits its own
    // caller node (idFor.clientSideAPICaller keys on sourceLine), so
    // we should see at least two with that urlLiteral.
    const all = callers(batch).filter((c) => c.urlLiteral === '/trpc/users.create');
    expect(all.length).toBeGreaterThanOrEqual(2);
    const methods = new Set(all.map((c) => c.httpMethod));
    expect(methods.has('POST')).toBe(true);
  });

  it('every emitted caller passes schema validation', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    for (const c of callers(batch)) {
      expect(() => validateNode(c)).not.toThrow();
    }
  });

  it('emits MAKES_REQUEST edge per caller', async () => {
    const batch = await extract('basic', 'src/UserList.ts');
    const makes = edgesOfType(batch, 'MAKES_REQUEST');
    const callerIds = new Set(callers(batch).map((c) => c.id));
    const matched = makes.filter((e) => callerIds.has(e.to));
    expect(matched.length).toBe(callers(batch).length);
  });
});

describe('trpc-client visitor — gates', () => {
  it('does NOT fire on files with no proxy-call shapes', async () => {
    // trpc.ts only declares the proxy; vanilla.ts ditto. Neither
    // contains a `x.y.z.useQuery()` / `.query()` / `.mutate()`
    // chain, so the visitor should emit zero callers regardless
    // of the (project-wide) plugin activation.
    const batch1 = await extract('basic', 'src/trpc.ts');
    expect(callers(batch1)).toHaveLength(0);
    const batch2 = await extract('basic', 'src/vanilla.ts');
    expect(callers(batch2)).toHaveLength(0);
  });

  it('does NOT fire on files that have proxy-call shapes but no trpc-flavored import', async () => {
    // NonTrpc.ts deliberately contains `db.users.query()`,
    // `store.values.user.mutate()`, and `x.y.z.useQuery()` patterns
    // imported from non-trpc fake libraries. The per-file gate
    // requires SOME imported specifier mentioning `trpc`. None of
    // NonTrpc.ts's imports do, so the visitor must emit zero
    // callers — this locks in the cheap mitigation for the
    // `.query()` / `.mutate()` cross-library collision risk.
    const batch = await extract('basic', 'src/NonTrpc.ts');
    expect(callers(batch)).toHaveLength(0);
  });
});
