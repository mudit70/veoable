import * as path from 'node:path';
import * as url from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type APIEndpoint,
  type ClientSideAPICaller,
  type ClientSideProcess,
  type DatabaseInteraction,
  type DatabaseTable,
} from '@veoable/schema';
import { makeBatchMeta } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { PrismaPlugin } from '@veoable/framework-prisma';
import { ReactPlugin } from '@veoable/framework-react';
import { ExpressPlugin } from '@veoable/framework-express';
import { FetchPlugin } from '@veoable/framework-fetch';
import {
  FLOW_STITCHER_PRODUCER_ID,
  createFlowWalker,
  stitchStore,
} from '@veoable/flow-stitcher';

/**
 * End-to-end demo (#39): React + Express + Prisma stitched into a
 * single canonical graph and walked via the flow walker.
 *
 * This test is the culmination of the entire build order. It proves
 * that when all the foundational pieces are wired together on a
 * realistic mini-app:
 *
 *   1. Prisma schema extraction produces DatabaseSystem + DatabaseTable
 *      + DatabaseColumn
 *   2. TS language plugin extracts functions + call graph
 *   3. React visitor emits ClientSideProcess nodes for useEffect + onClick
 *   4. Fetch visitor emits ClientSideAPICaller nodes
 *   5. Express visitor emits APIEndpoint nodes with handler functions
 *   6. Prisma visitor emits DatabaseInteraction + READS/WRITES edges
 *   7. Flow stitcher emits RESOLVES_TO_ENDPOINT edges
 *   8. Flow walker produces `complete` flows end-to-end
 *
 * The test does NOT mock any part of the pipeline. Every plugin runs
 * against the real fixture project, every commit goes through the
 * real SQLite canonical store, and the walker queries that store via
 * its public API.
 */

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/stack-react-express-prisma');

const FIXTURE_FILES = [
  'src/lib/prisma.ts',
  'src/services/users.ts',
  'src/services/posts.ts',
  'src/server.ts',
  'src/components/UsersPage.tsx',
];

let store: SQLiteCanonicalGraphStore;

beforeEach(() => {
  store = new SQLiteCanonicalGraphStore(':memory:');
});

afterEach(() => {
  store.close();
});

/**
 * Wire up the complete pipeline on the demo fixture and return the
 * populated store. Broken out as a helper so multiple tests can
 * reuse the exact same end-to-end run without repeating the
 * boilerplate.
 */
async function runFullPipeline(
  s: SQLiteCanonicalGraphStore
): Promise<{ ts: TsLanguagePlugin; schemaBatch: ReturnType<PrismaPlugin['onProjectLoaded']> }> {
  // ── Framework plugins ────────────────────────────────────────────
  const prisma = new PrismaPlugin();
  const react = new ReactPlugin();
  const express = new ExpressPlugin();
  const fetchPlugin = new FetchPlugin();

  // ── Project-level prelude (schema discovery) ─────────────────────
  // NOTE: `prisma.onProjectLoaded` MUST run before `registerVisitor(prisma.visitor)`
  // because the Prisma plugin binds its visitor to `_systemId`, which is
  // only populated after the schema batch is produced. Registering
  // earlier would bind the no-op placeholder and silently drop every
  // Prisma call-site.
  const schemaBatch = prisma.onProjectLoaded({
    rootDir: FIXTURE_ROOT,
    packageJson: null,
    files: [],
  });
  s.commit(schemaBatch, makeBatchMeta(prisma.id));

  // ── Language plugin + visitor registration ───────────────────────
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(prisma.visitor);
  ts.registerVisitor(react.visitor);
  ts.registerVisitor(express.visitor);
  ts.registerVisitor(fetchPlugin.visitor);

  const handle = await ts.loadProject({ rootDir: FIXTURE_ROOT });

  // ── Extract every source file into the canonical store ──────────
  for (const file of FIXTURE_FILES) {
    const batch = await ts.extractFile(handle, file);
    s.commit(batch, makeBatchMeta('ts'));
  }

  // ── Run the stitcher and commit its RESOLVES_TO_ENDPOINT edges ──
  const stitchBatch = stitchStore(s);
  s.commit(stitchBatch, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));

  return { ts, schemaBatch };
}

// ──────────────────────────────────────────────────────────────────────
// Schema side
// ──────────────────────────────────────────────────────────────────────

describe('stack: schema extraction', () => {
  it('the Prisma plugin contributes the User table', async () => {
    await runFullPipeline(store);
    const tables = store.findNodes('DatabaseTable');
    expect(tables.map((t: DatabaseTable) => t.name).sort()).toContain('User');
    const user = tables.find((t) => t.name === 'User')!;
    const columns = store.findNodes('DatabaseColumn', { tableId: user.id });
    // id, email, name, createdAt — 4 scalar columns
    expect(columns).toHaveLength(4);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Client-side processes
// ──────────────────────────────────────────────────────────────────────

describe('stack: client-side process extraction', () => {
  it('React plugin emits both useEffect and onClick processes', async () => {
    await runFullPipeline(store);
    const processes = store.findNodes('ClientSideProcess');
    const names = processes.map((p: ClientSideProcess) => p.name).sort();
    expect(names).toContain('useEffect');
    expect(names).toContain('onClick');
  });

  it('every process is attributed to the UsersPage component', async () => {
    await runFullPipeline(store);
    const processes = store.findNodes('ClientSideProcess');
    for (const process of processes) {
      const fn = store.getNode('FunctionDefinition', process.functionId);
      expect(fn).not.toBeNull();
      expect(fn!.name).toBe('UsersPage');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Client-side API callers
// ──────────────────────────────────────────────────────────────────────

describe('stack: fetch call detection', () => {
  it('Fetch plugin emits a caller for both endpoints', async () => {
    await runFullPipeline(store);
    const callers = store.findNodes('ClientSideAPICaller');
    expect(callers.length).toBeGreaterThanOrEqual(2);

    // `/api/users` — exact literal
    const listCaller = callers.find((c: ClientSideAPICaller) => c.urlLiteral === '/api/users');
    expect(listCaller).toBeDefined();
    expect(listCaller!.httpMethod).toBe('GET');
    expect(listCaller!.egressConfidence).toBe('exact');

    // `/api/users/${id}` — template prefix
    const detailCaller = callers.find(
      (c: ClientSideAPICaller) => c.urlLiteral === '/api/users/:p0' && c.egressConfidence === 'pattern'
    );
    expect(detailCaller).toBeDefined();
    expect(detailCaller!.httpMethod).toBe('GET');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Server-side endpoints
// ──────────────────────────────────────────────────────────────────────

describe('stack: Express endpoint extraction', () => {
  it('Express plugin emits both endpoints', async () => {
    await runFullPipeline(store);
    const endpoints = store.findNodes('APIEndpoint');
    const routes = endpoints.map((e: APIEndpoint) => `${e.httpMethod} ${e.routePattern}`).sort();
    expect(routes).toContain('GET /api/users');
    expect(routes).toContain('GET /api/users/:id');
  });

  it('both endpoints resolve their same-file handler functions', async () => {
    await runFullPipeline(store);
    const endpoints = store.findNodes('APIEndpoint');
    for (const endpoint of endpoints) {
      expect(endpoint.handlerFunctionId).not.toBeNull();
      const handler = store.getNode('FunctionDefinition', endpoint.handlerFunctionId!);
      expect(handler).not.toBeNull();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Database interactions
// ──────────────────────────────────────────────────────────────────────

describe('stack: Prisma interaction extraction', () => {
  it('Prisma plugin emits a read interaction against User for each service call', async () => {
    await runFullPipeline(store);
    const interactions = store.findNodes('DatabaseInteraction');
    const reads = interactions.filter((i: DatabaseInteraction) => i.operation === 'read');
    // `listUsers` → findMany; `getUserById` → findUnique — two reads.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const r of reads) {
      expect(r.orm).toBe('prisma');
      expect(r.confidence).toBe('direct');
    }
  });

  it('every read interaction has a READS edge to its expected table (User or Post)', async () => {
    await runFullPipeline(store);
    const interactions = store.findNodes('DatabaseInteraction');
    const user = store.findNodes('DatabaseTable', { name: 'User' })[0];
    const post = store.findNodes('DatabaseTable', { name: 'Post' })[0];
    expect(user).toBeDefined();
    expect(post).toBeDefined();

    // Branch by the call-site function: User-reading services (listUsers /
    // getUserById) MUST land on User; Post-reading services (#313 — the
    // database-receiver and PostService.* paths) MUST land on Post. This
    // preserves the original strength of "every read has the right edge"
    // while accommodating the new fixture's non-User reads.
    const userReaders = new Set(['listUsers', 'getUserById']);
    const postReaders = new Set(['listPostsViaDatabase', 'PostService.listAll']);
    const fns = store.findNodes('FunctionDefinition');
    const fnNameById = new Map(fns.map((f) => [f.id, f.name]));

    for (const interaction of interactions) {
      if (interaction.operation !== 'read') continue;
      const reads = store.findEdges(interaction.id, null, 'READS');
      expect(reads.length).toBeGreaterThan(0);
      const callerName = fnNameById.get(interaction.callSiteFunctionId) ?? '<unknown>';
      if (userReaders.has(callerName)) {
        expect(reads.some((e) => e.to === user.id)).toBe(true);
      } else if (postReaders.has(callerName)) {
        expect(reads.some((e) => e.to === post.id)).toBe(true);
      }
      // Other call sites: just require some READS edge (already asserted).
    }
  });

  // #313 — Non-conventional receiver names exercised end-to-end.
  // services/posts.ts uses `database = new PrismaClient()` (module-
  // level, non-canonical name) and `class PostService { storage = new
  // PrismaClient() }` (class field, non-canonical name). Pre-#5/#6
  // these would have been silently dropped by the legacy receiver-
  // name regex; post-#5/#6 the AST resolver follows them.
  it('detects non-conventional `database` receiver and emits direct-confidence read against Post', async () => {
    await runFullPipeline(store);
    const post = store.findNodes('DatabaseTable', { name: 'Post' })[0];
    expect(post).toBeDefined();

    const reads = store.findNodes('DatabaseInteraction')
      .filter((i: DatabaseInteraction) => i.operation === 'read');
    const postReads = reads.filter((i) =>
      store.findEdges(i.id, null, 'READS').some((e) => e.to === post.id),
    );
    // listPostsViaDatabase + PostService.listAll = 2 reads against Post.
    expect(postReads.length).toBeGreaterThanOrEqual(2);
    // All of them must be `direct` (AST-proved), not `inferred`.
    for (const r of postReads) {
      expect(r.confidence).toBe('direct');
      expect(r.orm).toBe('prisma');
    }
  });

  it('detects non-conventional class-field `this.storage` receiver and emits direct-confidence write against Post', async () => {
    await runFullPipeline(store);
    const post = store.findNodes('DatabaseTable', { name: 'Post' })[0];
    expect(post).toBeDefined();

    const writes = store.findNodes('DatabaseInteraction')
      .filter((i: DatabaseInteraction) => i.operation === 'write');
    const postWrites = writes.filter((i) =>
      store.findEdges(i.id, null, 'WRITES').some((e) => e.to === post.id),
    );
    // PostService.create = 1 write against Post via `this.storage`.
    expect(postWrites.length).toBeGreaterThanOrEqual(1);
    for (const w of postWrites) {
      expect(w.confidence).toBe('direct');
      expect(w.orm).toBe('prisma');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Stitcher
// ──────────────────────────────────────────────────────────────────────

describe('stack: flow stitcher URL matching', () => {
  it('emits RESOLVES_TO_ENDPOINT edges for both callers', async () => {
    await runFullPipeline(store);
    const resolves = store.findEdges(null, null, 'RESOLVES_TO_ENDPOINT');
    expect(resolves.length).toBeGreaterThanOrEqual(2);
  });

  it('the exact /api/users caller matches the /api/users endpoint at high + exact-url', async () => {
    await runFullPipeline(store);
    const callers = store.findNodes('ClientSideAPICaller');
    const listCaller = callers.find((c) => c.urlLiteral === '/api/users')!;
    const resolves = store.findEdges(listCaller.id, null, 'RESOLVES_TO_ENDPOINT');
    // After the #84 fix, exact-url strictly outranks pattern at the
    // same high confidence, so this full-literal caller produces
    // exactly one edge (the exact-url one) rather than an ambiguous
    // pair downgraded to low+inferred.
    expect(resolves).toHaveLength(1);
    const edge = resolves[0] as { matchConfidence: string; matchedBy: string };
    expect(edge.matchConfidence).toBe('high');
    expect(edge.matchedBy).toBe('exact-url');
  });

  it('the template-prefix /api/users/ caller matches /api/users/:id at high + pattern (segment-count)', async () => {
    await runFullPipeline(store);
    const callers = store.findNodes('ClientSideAPICaller');
    const detailCaller = callers.find(
      (c) => c.urlLiteral === '/api/users/:p0' && c.egressConfidence === 'pattern'
    )!;
    const resolves = store.findEdges(detailCaller.id, null, 'RESOLVES_TO_ENDPOINT');
    // With segment-count matching (#101), the template-prefix caller
    // with templateSpanCount=1 produces 3 total segments, which
    // deterministically matches /api/users/:id (3 segments) and
    // rejects /api/users/:userId/posts (4 segments). Confidence
    // upgrades from medium to high.
    expect(resolves).toHaveLength(1);
    const edge = resolves[0] as { matchConfidence: string; matchedBy: string };
    expect(edge.matchConfidence).toBe('high');
    expect(edge.matchedBy).toBe('pattern');
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end flow walking — the payoff
// ──────────────────────────────────────────────────────────────────────

describe('stack: end-to-end flow walking', () => {
  it('walkAllProcesses produces at least one complete flow ending at the User table', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();

    expect(flows.length).toBeGreaterThan(0);

    const completeFlows = flows.filter((f) => f.completeness === 'complete');
    expect(completeFlows.length).toBeGreaterThan(0);

    // Every complete flow should end at the User table via a READS hop.
    for (const flow of completeFlows) {
      expect(flow.databaseHops.length).toBeGreaterThan(0);
      const reachedUser = flow.databaseHops.some((hop) => hop.readsTable?.name === 'User');
      expect(reachedUser).toBe(true);
    }
  });

  it('the onClick flow reaches the /api/users/:id endpoint and its service helper', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();

    // Find a flow whose starting process is the onClick button.
    const onClickFlows = flows.filter((f) => f.startProcess.name === 'onClick');
    expect(onClickFlows.length).toBeGreaterThan(0);

    // At least one of those onClick flows should reach the getUserHandler.
    const reachedGetUserHandler = onClickFlows.some(
      (f) => f.handlerFunction?.name === 'getUserHandler'
    );
    expect(reachedGetUserHandler).toBe(true);

    // And at least one should be complete, reaching User via the service.
    const onClickComplete = onClickFlows.filter((f) => f.completeness === 'complete');
    expect(onClickComplete.length).toBeGreaterThan(0);
    for (const flow of onClickComplete) {
      const reachedUser = flow.databaseHops.some((h) => h.readsTable?.name === 'User');
      expect(reachedUser).toBe(true);
    }
  });

  it('the useEffect flow reaches the /api/users endpoint and the listUsersHandler', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();

    const useEffectFlows = flows.filter((f) => f.startProcess.name === 'useEffect');
    expect(useEffectFlows.length).toBeGreaterThan(0);

    const reachedListHandler = useEffectFlows.some(
      (f) => f.handlerFunction?.name === 'listUsersHandler'
    );
    expect(reachedListHandler).toBe(true);
  });

  it('every complete flow has a valid match confidence', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    const complete = flows.filter((f) => f.completeness === 'complete');
    for (const flow of complete) {
      expect(['high', 'medium', 'low']).toContain(flow.matchConfidence);
      expect(['exact-url', 'pattern', 'inferred']).toContain(flow.matchedBy);
    }
  });

  it('walks through the cross-file service layer (handler → service → prisma)', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();

    // For a complete useEffect flow, the interaction should be attributed
    // to `listUsers` (the service function), not to `listUsersHandler`.
    // This proves cross-file transitive CALLS_FUNCTION traversal works.
    const useEffectComplete = flows.filter(
      (f) => f.startProcess.name === 'useEffect' && f.completeness === 'complete'
    );
    expect(useEffectComplete.length).toBeGreaterThan(0);

    for (const flow of useEffectComplete) {
      for (const hop of flow.databaseHops) {
        const callSiteFn = store.getNode(
          'FunctionDefinition',
          hop.interaction.callSiteFunctionId
        );
        expect(callSiteFn).not.toBeNull();
        // The call-site function is the service function, not the handler.
        // This is the key assertion proving the walker crosses file
        // boundaries via CALLS_FUNCTION.
        expect(['listUsers', 'getUserById']).toContain(callSiteFn!.name);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Known limitation: named JSX handler references
// ──────────────────────────────────────────────────────────────────────

describe('stack: known limitation — named JSX handler references', () => {
  /**
   * The fixture's onClick deliberately uses an INLINE arrow rather
   * than a named handler. If we change `onClick={...}` to
   * `onClick={handleLoadUser}` where `handleLoadUser` is a
   * top-level `const` in the component body, the walker cannot
   * reach the fetch inside `handleLoadUser` because:
   *
   *   1. The React visitor attributes the `onClick` ClientSideProcess
   *      to the enclosing component (`UsersPage`), not to the named
   *      handler.
   *   2. `onClick={handleLoadUser}` is an identifier REFERENCE, not
   *      a call expression. The lang-ts call graph only emits
   *      `CALLS_FUNCTION` edges for actual call sites, so there is
   *      no edge from `UsersPage` to `handleLoadUser`.
   *   3. The walker BFS from `UsersPage` therefore never visits
   *      `handleLoadUser`, and the fetch inside it (whose caller
   *      functionId IS `handleLoadUser`) is unreachable.
   *
   * This is a real gap in the React visitor + walker pipeline.
   * Options to fix it in a future PR:
   *   (a) React visitor emits a synthetic `CALLS_FUNCTION` edge
   *       from the component to the referenced handler function
   *       when the JSX attribute value is an identifier resolving
   *       to a same-file function.
   *   (b) React visitor attributes the ClientSideProcess to the
   *       handler function directly (not the component) when the
   *       handler is a named reference.
   *   (c) Walker exposes JSX attribute references as a separate
   *       traversal edge class.
   *
   * Pinned here as a test comment rather than an executable test
   * because demonstrating the gap requires a second fixture with
   * named handlers, and the cost of that fixture outweighs the
   * value of the pin. Delete this comment and uncomment the
   * fixture when the gap is closed.
   */
  it('is documented in the comment above; the fixture uses inline handlers', () => {
    expect(true).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Canonical store attribution
// ──────────────────────────────────────────────────────────────────────

describe('stack: canonical store batch attribution', () => {
  it('records batches from every plugin that contributed', async () => {
    await runFullPipeline(store);
    const batches = store.listBatches();
    const producers = new Set(batches.map((b) => b.producedBy));
    expect(producers.has('prisma')).toBe(true);
    expect(producers.has('ts')).toBe(true);
    expect(producers.has(FLOW_STITCHER_PRODUCER_ID)).toBe(true);
  });

  it('commits exactly one prisma schema batch, one ts batch per source file, and one stitcher batch', async () => {
    await runFullPipeline(store);
    const batches = store.listBatches();
    const byProducer = new Map<string, number>();
    for (const b of batches) {
      byProducer.set(b.producedBy, (byProducer.get(b.producedBy) ?? 0) + 1);
    }
    expect(byProducer.get('prisma')).toBe(1);
    expect(byProducer.get('ts')).toBe(FIXTURE_FILES.length);
    expect(byProducer.get(FLOW_STITCHER_PRODUCER_ID)).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin-contract good citizen checks
// ──────────────────────────────────────────────────────────────────────

describe('stack: plugin contracts', () => {
  it('prisma.onProjectLoaded returns a non-empty schema batch', async () => {
    const { schemaBatch } = await runFullPipeline(store);
    const systems = schemaBatch.nodes.filter((n) => n.nodeType === 'DatabaseSystem');
    const tables = schemaBatch.nodes.filter((n) => n.nodeType === 'DatabaseTable');
    expect(systems.length).toBeGreaterThanOrEqual(1);
    expect(tables.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Flow count / confidence pinning
// ──────────────────────────────────────────────────────────────────────

describe('stack: flow shape pinning', () => {
  it('produces exactly the expected number of complete flows', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    // Pinned observed count — drift detector.
    //
    // Flow breakdown after scope-narrowed traversal (#102):
    //   - useEffect has a TRIGGERS edge to its specific callback,
    //     which contains fetch('/api/users'). This resolves to
    //     GET /api/users at high + exact-url. The handler reaches
    //     both service functions via the call graph, producing 1
    //     complete flow (with 2 DB hops).
    //   - onClick has a TRIGGERS edge to its specific callback,
    //     which contains fetch(`/api/users/${id}`). This resolves
    //     to GET /api/users/:id at high + pattern (segment-count).
    //     Same handler, 1 complete flow.
    //   - Total: 2 complete flows. Previously this was 4 because
    //     both processes shared the component function scope and
    //     each saw both callers.
    const complete = flows.filter((f) => f.completeness === 'complete');
    expect(complete).toHaveLength(2);
  });

  it('the exact-literal useEffect flow reaches a high + exact-url flow', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    const useEffectComplete = flows.filter(
      (f) => f.startProcess.name === 'useEffect' && f.completeness === 'complete'
    );
    expect(useEffectComplete.length).toBeGreaterThan(0);
    expect(useEffectComplete.some((f) => f.matchConfidence === 'high' && f.matchedBy === 'exact-url')).toBe(true);
  });

  it('complete flows carry a match descriptor consistent with their caller URL', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    const complete = flows.filter((f) => f.completeness === 'complete');
    expect(complete.length).toBeGreaterThan(0);
    // Each caller resolves unambiguously:
    //   - Exact literal `/api/users` → /api/users at high+exact-url
    //   - Template prefix `/api/users/` → /api/users/:id at high+pattern (segment-count #101)
    //
    // Note on walker semantics: every `ClientSideProcess` in a
    // component sees ALL callers reachable from that component via
    // the call graph, because processes don't carry per-attribute
    // attribution. So a single component's onClick and useEffect
    // processes each fan out through BOTH callers in the component's
    // body. The assertion below covers both caller URLs independently
    // so it doesn't care which process a flow started from.
    for (const flow of complete) {
      const urlLiteral = flow.caller!.urlLiteral;
      if (urlLiteral === '/api/users') {
        expect(flow.matchConfidence).toBe('high');
        expect(flow.matchedBy).toBe('exact-url');
        expect(flow.endpoint?.routePattern).toBe('/api/users');
      } else if (urlLiteral === '/api/users/:p0') {
        expect(flow.matchConfidence).toBe('high');
        expect(flow.matchedBy).toBe('pattern');
        expect(flow.endpoint?.routePattern).toBe('/api/users/:id');
      } else {
        throw new Error(`unexpected caller urlLiteral: ${urlLiteral ?? '<null>'}`);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// walkFromProcess parity + empty-store sanity
// ──────────────────────────────────────────────────────────────────────

describe('stack: walker entry points', () => {
  it('walkFromProcess returns a subset consistent with walkAllProcesses for the same start', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const allFlows = walker.walkAllProcesses();
    const useEffectProcess = store
      .findNodes('ClientSideProcess')
      .find((p) => p.name === 'useEffect')!;
    expect(useEffectProcess).toBeDefined();

    const singleFlows = walker.walkFromProcess(useEffectProcess.id);
    const allUseEffectFlows = allFlows.filter((f) => f.startProcess.id === useEffectProcess.id);

    expect(singleFlows.length).toBe(allUseEffectFlows.length);
    // Each single-process flow should have the same start process.
    for (const f of singleFlows) {
      expect(f.startProcess.id).toBe(useEffectProcess.id);
    }
  });

  it('walkAllProcesses on an empty store returns []', () => {
    const empty = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const walker = createFlowWalker(empty);
      expect(walker.walkAllProcesses()).toEqual([]);
    } finally {
      empty.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Bidirectional flow data (#108)
// ──────────────────────────────────────────────────────────────────────

describe('stack: server response extraction', () => {
  it('getUserHandler has both 200 and 404 (error) response shapes', async () => {
    await runFullPipeline(store);
    const fns = store.findNodes('FunctionDefinition');
    const getUserHandler = fns.find((f) => f.name === 'getUserHandler');
    expect(getUserHandler).toBeDefined();
    expect(getUserHandler!.responses).toBeDefined();
    expect(getUserHandler!.responses!.length).toBe(2);

    // 404 is an error path (status >= 400)
    const error = getUserHandler!.responses!.find((r) => r.statusCode === 404);
    expect(error).toBeDefined();
    expect(error!.isErrorPath).toBe(true);

    // 200 is the success path
    const success = getUserHandler!.responses!.find((r) => r.statusCode === 200);
    expect(success).toBeDefined();
    expect(success!.isErrorPath).toBe(false);
  });

  it('listUsersHandler responds with 200 and body', async () => {
    await runFullPipeline(store);
    const fns = store.findNodes('FunctionDefinition');
    const handler = fns.find((f) => f.name === 'listUsersHandler');
    expect(handler).toBeDefined();
    expect(handler!.responses).toBeDefined();
    expect(handler!.responses).toHaveLength(1);
    expect(handler!.responses![0].statusCode).toBe(200);
    expect(handler!.responses![0].bodyExpression).toBe('users');
    expect(handler!.responses![0].isErrorPath).toBe(false);
  });

  it('functions without a res parameter have no responses', async () => {
    await runFullPipeline(store);
    const fns = store.findNodes('FunctionDefinition');
    const listUsers = fns.find((f) => f.name === 'listUsers');
    expect(listUsers).toBeDefined();
    expect(listUsers!.responses).toBeUndefined();
  });
});

describe('stack: client response chain extraction', () => {
  it('GET /api/users caller has json-parse and state-update response handlers', async () => {
    await runFullPipeline(store);
    const callers = store.findNodes('ClientSideAPICaller');
    const getUsersCaller = callers.find(
      (c) => c.urlLiteral === '/api/users' && c.httpMethod === 'GET'
    );
    expect(getUsersCaller).toBeDefined();
    expect(getUsersCaller!.responseHandlers).toBeDefined();
    expect(getUsersCaller!.responseHandlers).toHaveLength(2);
    expect(getUsersCaller!.responseHandlers![0].kind).toBe('json-parse');
    expect(getUsersCaller!.responseHandlers![1].kind).toBe('state-update');
    expect(getUsersCaller!.responseHandlers![1].expression).toBe('setUsers');
    expect(getUsersCaller!.responseHandlers![1].targetStateVar).toBe('users');
  });
});

describe('stack: bidirectional flow data in walk results', () => {
  it('complete flows carry responses and responseHandlers', async () => {
    await runFullPipeline(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    const complete = flows.filter((f) => f.completeness === 'complete');
    expect(complete.length).toBeGreaterThan(0);

    // Every complete flow should have responses array (may be empty for some).
    for (const flow of complete) {
      expect(Array.isArray(flow.responses)).toBe(true);
      expect(Array.isArray(flow.responseHandlers)).toBe(true);
    }

    // The GET /api/users flow should have both responses and responseHandlers.
    const listFlow = complete.find(
      (f) => f.endpoint?.routePattern === '/api/users' && f.endpoint?.httpMethod === 'GET'
    );
    expect(listFlow).toBeDefined();
    expect(listFlow!.responses.length).toBeGreaterThan(0);
    expect(listFlow!.responses[0].statusCode).toBe(200);
    expect(listFlow!.responseHandlers.length).toBeGreaterThan(0);
    expect(listFlow!.responseHandlers[0].kind).toBe('json-parse');
  });
});
