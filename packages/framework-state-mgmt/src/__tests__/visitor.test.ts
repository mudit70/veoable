import * as path from 'node:path';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateNode,
  type ClientSideProcess,
  type ReadsStateEdge,
  type SchemaEdge,
  type SchemaNode,
  type StateStore,
  type WritesStateEdge,
} from '@veoable/schema';
import { makeBatchMeta, type NodeBatch } from '@veoable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@veoable/graph-db';
import { TsLanguagePlugin } from '@veoable/lang-ts';
import { StateMgmtPlugin } from '../index.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/state-mgmt');
const fixturePath = (scenario: string) => path.join(FIXTURE_ROOT, scenario);

async function extract(scenario: string, file: string): Promise<NodeBatch> {
  const plugin = new StateMgmtPlugin();
  const ts = new TsLanguagePlugin();
  ts.registerVisitor(plugin.visitor);
  const handle = await ts.loadProject({ rootDir: fixturePath(scenario) });
  return ts.extractFile(handle, file);
}

function processes(batch: { nodes: SchemaNode[] }): ClientSideProcess[] {
  return batch.nodes.filter((n): n is ClientSideProcess => n.nodeType === 'ClientSideProcess');
}

// ──────────────────────────────────────────────────────────────────────
// Redux Toolkit
// ──────────────────────────────────────────────────────────────────────

describe('redux toolkit detection', () => {
  it('detects createAsyncThunk as state_observer', async () => {
    const batch = await extract('basic', 'src/redux-store.ts');
    const procs = processes(batch);
    const thunks = procs.filter((p) => p.name.startsWith('createAsyncThunk:'));
    expect(thunks.length).toBe(2);
    for (const t of thunks) {
      expect(t.kind).toBe('state_observer');
      expect(t.framework).toBe('redux');
    }
  });

  it('includes the thunk type name in the process name', async () => {
    const batch = await extract('basic', 'src/redux-store.ts');
    const procs = processes(batch);
    const names = procs.map((p) => p.name);
    expect(names).toContain('createAsyncThunk:users/fetch');
    expect(names).toContain('createAsyncThunk:users/remove');
  });

  it('does not detect createSlice as a process', async () => {
    const batch = await extract('basic', 'src/redux-store.ts');
    const procs = processes(batch);
    const slices = procs.filter((p) => p.name.includes('createSlice'));
    expect(slices).toHaveLength(0);
  });

  it('every process passes schema validation', async () => {
    const batch = await extract('basic', 'src/redux-store.ts');
    for (const p of processes(batch)) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Zustand
// ──────────────────────────────────────────────────────────────────────

describe('zustand detection', () => {
  it('detects create() as state_observer', async () => {
    const batch = await extract('basic', 'src/zustand-store.ts');
    const procs = processes(batch);
    const creates = procs.filter((p) => p.name === 'zustand:create');
    expect(creates.length).toBe(1);
    expect(creates[0].kind).toBe('state_observer');
    expect(creates[0].framework).toBe('zustand');
  });
});

// ──────────────────────────────────────────────────────────────────────
// #192 — Zustand StateStore + READS_STATE / WRITES_STATE
// ──────────────────────────────────────────────────────────────────────

function stores(batch: { nodes: SchemaNode[] }): StateStore[] {
  return batch.nodes.filter((n): n is StateStore => n.nodeType === 'StateStore');
}

function readsStateEdges(batch: { edges: SchemaEdge[] }): ReadsStateEdge[] {
  return batch.edges.filter((e): e is ReadsStateEdge => e.edgeType === 'READS_STATE');
}

function writesStateEdges(batch: { edges: SchemaEdge[] }): WritesStateEdge[] {
  return batch.edges.filter((e): e is WritesStateEdge => e.edgeType === 'WRITES_STATE');
}

describe('zustand StateStore (#192)', () => {
  it('emits a StateStore node for `const useStore = create(...)`', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    const all = stores(batch);
    expect(all).toHaveLength(1);
    const s = all[0];
    expect(s.name).toBe('useCounterStore');
    expect(s.framework).toBe('zustand');
    expect(s.fields.map((f) => f.name).sort()).toEqual(['count', 'label']);
    expect(s.actions.sort()).toEqual(['increment', 'setLabel']);
  });

  it('emits READS_STATE for `useStore(s => s.foo)` with field name', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    const reads = readsStateEdges(batch);
    const fields = reads.map((e) => e.field).filter((f) => f !== null && f !== undefined);
    expect(fields).toContain('count');
  });

  it('emits READS_STATE with null field for broader selectors', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    const reads = readsStateEdges(batch);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    const broadField = reads.find((e) => e.field === null || e.field === undefined);
    expect(broadField).toBeTruthy();
  });

  it('emits WRITES_STATE for `useStore.getState().<action>()`', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    const writes = writesStateEdges(batch);
    const actions = writes.map((e) => e.action);
    expect(actions.sort()).toEqual(['increment', 'setLabel']);
  });

  it('READS_STATE / WRITES_STATE edges target the same StateStore id', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    const all = stores(batch);
    const storeId = all[0].id;
    for (const e of readsStateEdges(batch)) expect(e.to).toBe(storeId);
    for (const e of writesStateEdges(batch)) expect(e.to).toBe(storeId);
  });

  it('every StateStore passes schema validation', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    for (const s of stores(batch)) {
      expect(() => validateNode(s)).not.toThrow();
    }
  });

  it('does NOT emit state edges for non-Zustand `.create` / `.getState()`', async () => {
    const batch = await extract('basic', 'src/zustand-rw.ts');
    // The fixture has `Model.create(...)` (PropertyAccess `.create`,
    // non-arrow first arg) and `reduxStoreLike.getState().foo`. Neither
    // should attach to any StateStore. We assert that no read/write
    // edge points at a store id we never emitted, and no edge has
    // action 'foo' (the only would-be false-positive action).
    const emittedIds = new Set(stores(batch).map((s) => s.id));
    for (const e of readsStateEdges(batch)) expect(emittedIds.has(e.to)).toBe(true);
    for (const e of writesStateEdges(batch)) expect(emittedIds.has(e.to)).toBe(true);
    const writes = writesStateEdges(batch).map((e) => e.action);
    expect(writes).not.toContain('foo');
  });
});

describe('zustand StateStore — curried / renamed / middleware (#192)', () => {
  it('emits StateStore for renamed import `import { create as makeStore }`', async () => {
    const batch = await extract('basic', 'src/zustand-curried.ts');
    const all = stores(batch);
    const toggle = all.find((s) => s.name === 'useToggleStore');
    expect(toggle).toBeTruthy();
    expect(toggle!.fields.map((f) => f.name)).toEqual(['open']);
    expect(toggle!.actions).toEqual(['setOpen']);
  });

  it('resolves READS_STATE / WRITES_STATE on a renamed-import store', async () => {
    const batch = await extract('basic', 'src/zustand-curried.ts');
    const toggle = stores(batch).find((s) => s.name === 'useToggleStore')!;
    const reads = readsStateEdges(batch).filter((e) => e.to === toggle.id);
    const writes = writesStateEdges(batch).filter((e) => e.to === toggle.id);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(writes.map((e) => e.action)).toContain('setOpen');
  });

  it('emits StateStore for middleware-wrapped `create(persist(...))`', async () => {
    const batch = await extract('basic', 'src/zustand-curried.ts');
    const profile = stores(batch).find((s) => s.name === 'useProfileStore');
    expect(profile).toBeTruthy();
    expect(profile!.fields.map((f) => f.name)).toEqual(['name']);
    expect(profile!.actions).toEqual(['setName']);
  });

  it('resolves READS_STATE / WRITES_STATE on a middleware-wrapped store', async () => {
    const batch = await extract('basic', 'src/zustand-curried.ts');
    const profile = stores(batch).find((s) => s.name === 'useProfileStore')!;
    const reads = readsStateEdges(batch).filter((e) => e.to === profile.id);
    const writes = writesStateEdges(batch).filter((e) => e.to === profile.id);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(writes.map((e) => e.action)).toContain('setName');
  });
});

// ──────────────────────────────────────────────────────────────────────
// MobX
// ──────────────────────────────────────────────────────────────────────

describe('mobx detection', () => {
  it('detects autorun as state_observer', async () => {
    const batch = await extract('basic', 'src/mobx-store.ts');
    const procs = processes(batch);
    const autoruns = procs.filter((p) => p.name === 'autorun');
    expect(autoruns.length).toBe(1);
    expect(autoruns[0].kind).toBe('state_observer');
    expect(autoruns[0].framework).toBe('mobx');
  });

  it('detects reaction as state_observer', async () => {
    const batch = await extract('basic', 'src/mobx-store.ts');
    const procs = processes(batch);
    const reactions = procs.filter((p) => p.name === 'reaction');
    expect(reactions.length).toBe(1);
    expect(reactions[0].kind).toBe('state_observer');
    expect(reactions[0].framework).toBe('mobx');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pinia
// ──────────────────────────────────────────────────────────────────────

describe('pinia detection', () => {
  it('detects defineStore as state_observer', async () => {
    const batch = await extract('basic', 'src/pinia-store.ts');
    const procs = processes(batch);
    const stores = procs.filter((p) => p.name.startsWith('defineStore:'));
    expect(stores.length).toBe(1);
    expect(stores[0].kind).toBe('state_observer');
    expect(stores[0].framework).toBe('pinia');
    expect(stores[0].name).toBe('defineStore:users');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Generic dispatch
// ──────────────────────────────────────────────────────────────────────

describe('dispatch detection', () => {
  it('detects dispatch() calls as event_handler', async () => {
    const batch = await extract('basic', 'src/dispatch-usage.ts');
    const procs = processes(batch);
    const dispatches = procs.filter((p) => p.name === 'dispatch');
    expect(dispatches.length).toBe(2);
    for (const d of dispatches) {
      expect(d.kind).toBe('event_handler');
      expect(d.framework).toBe('state-mgmt');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #256 Phase A — Redux Saga take-effect detection
// ──────────────────────────────────────────────────────────────────────

describe('redux-saga take-effect detection (#256 Phase A)', () => {
  function callsFunctionEdges(batch: { edges: SchemaEdge[] }) {
    return batch.edges.filter((e): e is import('@veoable/schema').CallsFunctionEdge => e.edgeType === 'CALLS_FUNCTION');
  }

  it('emits a ClientSideProcess for takeLatest with imported-constant action type', async () => {
    const batch = await extract('basic', 'src/saga.ts');
    const procs = processes(batch);
    const sagaProcs = procs.filter((p) => p.framework === 'redux-saga');
    const names = sagaProcs.map((p) => p.name);
    // Must include the imported-constant action type, the string-literal,
    // the throttled, AND the inline-handler entry.
    expect(names).toContain('saga:LOGIN_USER_REQUEST');
    expect(names).toContain('saga:LOGOUT_USER');
    expect(names).toContain('saga:SEARCH');
    expect(names).toContain('saga:REGISTER_USER_REQUEST');
  });

  it('classifies saga handlers as event_handler kind', async () => {
    const batch = await extract('basic', 'src/saga.ts');
    const sagaProcs = processes(batch).filter((p) => p.framework === 'redux-saga');
    expect(sagaProcs.length).toBeGreaterThan(0);
    for (const p of sagaProcs) {
      expect(p.kind).toBe('event_handler');
    }
  });

  it('emits a CALLS_FUNCTION edge from the registering generator to the named handler', async () => {
    const batch = await extract('basic', 'src/saga.ts');
    const callsEdges = callsFunctionEdges(batch);
    // We need at LEAST 3 saga-driven CALLS_FUNCTION edges (loginModule,
    // logoutModule, searchModule). Inline anonymous handler doesn't
    // produce one (no resolvable function id) and the lang-ts walker
    // synthesizes its own CALLS_FUNCTION for the call() helpers, so
    // the actual edge count is higher — assert lower bound only.
    const handlers = ['loginModule', 'logoutModule', 'searchModule'];
    const fns = batch.nodes.filter(
      (n): n is import('@veoable/schema').FunctionDefinition => n.nodeType === 'FunctionDefinition',
    );
    const targetIds = new Set(
      handlers.map((name) => fns.find((f) => f.name === name)?.id).filter(Boolean) as string[],
    );
    const sagaEdges = callsEdges.filter((e) => e.confidence === 'indirect' && targetIds.has(e.to));
    expect(sagaEdges.length).toBeGreaterThanOrEqual(3);
  });

  it('throttle/debounce form with leading delay arg also matches', async () => {
    const batch = await extract('basic', 'src/saga.ts');
    const sagaProcs = processes(batch).filter((p) => p.framework === 'redux-saga');
    expect(sagaProcs.find((p) => p.name === 'saga:SEARCH')).toBeDefined();
  });

  it('inline anonymous handler still emits the saga ClientSideProcess but no CALLS_FUNCTION edge', async () => {
    // The REGISTER_USER_REQUEST entry uses an inline `function* () {...}`.
    // We emit the ClientSideProcess (saga is visible) but skip the edge
    // because there's no resolvable named FunctionDefinition.id to
    // point at.
    const batch = await extract('basic', 'src/saga.ts');
    const sagaProcs = processes(batch).filter(
      (p) => p.framework === 'redux-saga' && p.name === 'saga:REGISTER_USER_REQUEST',
    );
    expect(sagaProcs.length).toBe(1);
  });

  it('every emitted saga process passes schema validation', async () => {
    const batch = await extract('basic', 'src/saga.ts');
    const sagaProcs = processes(batch).filter((p) => p.framework === 'redux-saga');
    for (const p of sagaProcs) {
      expect(() => validateNode(p)).not.toThrow();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #256 Phase B — RTK createAsyncThunk dispatch indirection
// ──────────────────────────────────────────────────────────────────────

describe('rtk createAsyncThunk dispatch indirection (#256 Phase B)', () => {
  function fnsByName(batch: { nodes: SchemaNode[] }, name: string) {
    return batch.nodes.filter(
      (n): n is import('@veoable/schema').FunctionDefinition =>
        n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === name,
    );
  }
  function callsEdgesTo(batch: { edges: SchemaEdge[] }, target: string) {
    return batch.edges.filter(
      (e): e is import('@veoable/schema').CallsFunctionEdge =>
        e.edgeType === 'CALLS_FUNCTION' && e.to === target,
    );
  }

  it('dispatch(thunk(args)) emits CALLS_FUNCTION → named payload creator', async () => {
    const batch = await extract('basic', 'src/rtk-thunk.ts');
    const fetchPayload = fnsByName(batch, 'fetchUserPayload')[0];
    expect(fetchPayload).toBeDefined();
    const edges = callsEdgesTo(batch, fetchPayload.id);
    // dispatch(fetchUser(id)) and dispatch(fetchUser()) — both
    // resolve to fetchUserPayload via the same creator.
    const indirectEdges = edges.filter((e) => e.confidence === 'indirect');
    expect(indirectEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatch(thunk) with no call also resolves to payload creator', async () => {
    const batch = await extract('basic', 'src/rtk-thunk.ts');
    // removeUserPayload is a variable-bound arrow.
    const removePayload = fnsByName(batch, 'removeUserPayload')[0];
    expect(removePayload).toBeDefined();
    const edges = callsEdgesTo(batch, removePayload.id);
    const indirectEdges = edges.filter((e) => e.confidence === 'indirect');
    expect(indirectEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('inline arrow payload creator emits NO thunk edge (no named id)', async () => {
    const batch = await extract('basic', 'src/rtk-thunk.ts');
    // The dispatch(inlineThunk(id)) should not produce an edge into
    // any payload creator function — there isn't one named.
    // Confirm by checking no indirect edge points at a function with
    // name 'inlineThunk' (because lang-ts wouldn't emit a FunctionDefinition
    // with that name — the inline arrow has no parent VariableDeclaration
    // pattern at the createAsyncThunk arg position).
    const inlineFns = fnsByName(batch, 'inlineThunk');
    // The variable `inlineThunk` itself isn't a function (it's a thunk
    // creator binding). Most importantly, no synthetic edge should
    // appear. We check the absence indirectly by counting indirect
    // edges from dispatchScenarios — they should be 2 (fetchUser × 2 +
    // removeUser × 1 minus one for thunk-without-call case = 3 actually).
    void inlineFns;
    const dispatchFn = fnsByName(batch, 'dispatchScenarios')[0];
    expect(dispatchFn).toBeDefined();
    const indirectEdges = batch.edges.filter(
      (e) => e.edgeType === 'CALLS_FUNCTION' && e.from === dispatchFn.id && (e as any).confidence === 'indirect',
    );
    // Expect exactly 3 indirect edges from dispatchScenarios. Edge ids
    // are content-addressed including sourceLine, so the two
    // fetchUser dispatches at distinct lines emit two distinct edges
    // (NOT collapsed). Tally:
    //   line 33: dispatch(fetchUser(id))   → fetchUserPayload
    //   line 35: dispatch(fetchUser())     → fetchUserPayload
    //   line 37: dispatch(removeUser)      → removeUserPayload
    // Inline & non-thunk dispatches contribute 0.
    expect(indirectEdges.length).toBe(3);
  });

  it('dispatch of plain (non-thunk) action creator emits NO thunk edge', async () => {
    const batch = await extract('basic', 'src/rtk-thunk.ts');
    // No FunctionDefinition for nonThunkAction's payload should be the
    // target of an indirect edge from dispatchScenarios.
    const nonThunkFns = fnsByName(batch, 'nonThunkAction');
    expect(nonThunkFns.length).toBe(1);
    const indirectIntoNonThunk = batch.edges.filter(
      (e) => e.edgeType === 'CALLS_FUNCTION' && e.to === nonThunkFns[0].id && (e as any).confidence === 'indirect',
    );
    expect(indirectIntoNonThunk.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #256 Phase C — TanStack / RTK Query data-fetching indirection
// ──────────────────────────────────────────────────────────────────────

describe('tanstack/rtk query indirection (#256 Phase C)', () => {
  function fnsByName(batch: { nodes: SchemaNode[] }, name: string) {
    return batch.nodes.filter(
      (n): n is import('@veoable/schema').FunctionDefinition =>
        n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === name,
    );
  }
  function indirectEdgesFrom(batch: { edges: SchemaEdge[]; nodes: SchemaNode[] }, fnName: string) {
    const fn = fnsByName(batch, fnName)[0];
    if (!fn) return [];
    return batch.edges.filter(
      (e) => e.edgeType === 'CALLS_FUNCTION' && e.from === fn.id && (e as any).confidence === 'indirect',
    );
  }

  it('useQuery({queryFn: namedFn}) emits CALLS_FUNCTION → fetchUsers', async () => {
    const batch = await extract('basic', 'src/tanstack.ts');
    const fetchFn = fnsByName(batch, 'fetchUsers')[0];
    expect(fetchFn).toBeDefined();
    const edges = indirectEdgesFrom(batch, 'UsersList');
    expect(edges.find((e) => e.to === fetchFn.id)).toBeDefined();
  });

  it('useQuery with inline-arrow queryFn — edge → "queryFn" FunctionDefinition (Pattern 4)', async () => {
    const batch = await extract('basic', 'src/tanstack.ts');
    // lang-ts emits the inline arrow as a FunctionDefinition named 'queryFn'.
    const queryFnDefs = fnsByName(batch, 'queryFn');
    expect(queryFnDefs.length).toBeGreaterThanOrEqual(1);
    const edges = indirectEdgesFrom(batch, 'PostsList');
    const target = queryFnDefs.find((f) => edges.some((e) => e.to === f.id));
    expect(target).toBeDefined();
  });

  it('legacy positional-arg form useQuery([key], fn) emits the edge', async () => {
    const batch = await extract('basic', 'src/tanstack.ts');
    const fetchFn = fnsByName(batch, 'fetchUsers')[0];
    const edges = indirectEdgesFrom(batch, 'LegacyList');
    expect(edges.find((e) => e.to === fetchFn.id)).toBeDefined();
  });

  it('useMutation({mutationFn: namedFn}) emits CALLS_FUNCTION → createUser', async () => {
    const batch = await extract('basic', 'src/tanstack.ts');
    const createFn = fnsByName(batch, 'createUser')[0];
    expect(createFn).toBeDefined();
    const edges = indirectEdgesFrom(batch, 'CreateUserForm');
    expect(edges.find((e) => e.to === createFn.id)).toBeDefined();
  });

  it('useMutation with inline-arrow mutationFn — edge → "mutationFn" FunctionDefinition', async () => {
    const batch = await extract('basic', 'src/tanstack.ts');
    const mutationFnDefs = fnsByName(batch, 'mutationFn');
    expect(mutationFnDefs.length).toBeGreaterThanOrEqual(1);
    const edges = indirectEdgesFrom(batch, 'DeleteUserForm');
    const target = mutationFnDefs.find((f) => edges.some((e) => e.to === f.id));
    expect(target).toBeDefined();
  });

  it('useInfiniteQuery and useSuspenseQuery hooks also emit edges', async () => {
    const batch = await extract('basic', 'src/tanstack.ts');
    expect(indirectEdgesFrom(batch, 'FeedList').length).toBeGreaterThan(0);
    expect(indirectEdgesFrom(batch, 'SuspenseList').length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #264 — gate by import source
// ──────────────────────────────────────────────────────────────────────

describe('hook detection gated by import source (#264)', () => {
  it('app-local useQuery (not imported from @tanstack/react-query) emits no CALLS_FUNCTION edge', async () => {
    const batch = await extract('basic', 'src/local-helpers.ts');
    const localConsumerFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === 'LocalConsumer',
    );
    expect(localConsumerFn).toBeDefined();
    // The fetchLocal function exists and would be the target if the
    // visitor had wrongly fired. Confirm there's no indirect edge.
    const fetchLocalFn = batch.nodes.find(
      (n) => n.nodeType === 'FunctionDefinition' && (n as { name: string }).name === 'fetchLocal',
    );
    expect(fetchLocalFn).toBeDefined();
    const indirect = batch.edges.filter(
      (e) => e.edgeType === 'CALLS_FUNCTION'
        && e.from === localConsumerFn!.id
        && e.to === fetchLocalFn!.id
        && (e as { confidence: string }).confidence === 'indirect',
    );
    expect(indirect.length).toBe(0);
  });

  it('app-local takeLatest (not imported from redux-saga/effects) emits no saga ClientSideProcess', async () => {
    const batch = await extract('basic', 'src/local-helpers.ts');
    const sagaProcs = processes(batch).filter(
      (p) => p.framework === 'redux-saga' && p.name === 'saga:LOCAL_ACTION',
    );
    expect(sagaProcs.length).toBe(0);
  });

  it('renamed import (`takeLatest as tl`) still triggers saga detection', async () => {
    // canonicalCalleeName traces the alias back to the original export
    // name so the dispatch table fires.
    const batch = await extract('basic', 'src/saga-renamed.ts');
    const sagaProcs = processes(batch).filter(
      (p) => p.framework === 'redux-saga' && p.name === 'saga:LOGIN_RENAMED',
    );
    expect(sagaProcs.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Negative cases
// ──────────────────────────────────────────────────────────────────────

describe('negative cases', () => {
  it('does not match generic create() with non-function argument', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const procs = processes(batch);
    const zustandCreates = procs.filter((p) => p.name === 'zustand:create');
    expect(zustandCreates).toHaveLength(0);
  });

  it('does not match dispatch() with string argument', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const procs = processes(batch);
    const dispatches = procs.filter((p) => p.name === 'dispatch');
    expect(dispatches).toHaveLength(0);
  });

  it('does not match createAsyncThunk() without string first arg', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const procs = processes(batch);
    const thunks = procs.filter((p) => p.name.startsWith('createAsyncThunk:'));
    expect(thunks).toHaveLength(0);
  });

  it('does not match defineStore() without string first arg', async () => {
    const batch = await extract('basic', 'src/negatives.ts');
    const procs = processes(batch);
    const stores = procs.filter((p) => p.name.startsWith('defineStore:'));
    expect(stores).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plugin contract
// ──────────────────────────────────────────────────────────────────────

describe('StateMgmtPlugin contract', () => {
  it('has id="state-mgmt" and language="ts"', () => {
    const plugin = new StateMgmtPlugin();
    expect(plugin.id).toBe('state-mgmt');
    expect(plugin.language).toBe('ts');
  });

  it('appliesTo returns true for Redux projects', () => {
    const plugin = new StateMgmtPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { '@reduxjs/toolkit': '^2.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true for Zustand projects', () => {
    const plugin = new StateMgmtPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { zustand: '^4.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true for MobX projects', () => {
    const plugin = new StateMgmtPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { mobx: '^6.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns true for Pinia projects', () => {
    const plugin = new StateMgmtPlugin();
    expect(
      plugin.appliesTo({
        rootDir: '/nowhere',
        packageJson: { dependencies: { pinia: '^2.0.0' } },
        files: [],
      })
    ).toBe(true);
  });

  it('appliesTo returns false for unrelated projects', () => {
    const plugin = new StateMgmtPlugin();
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
  it('all processes commit cleanly', async () => {
    const store = new SQLiteCanonicalGraphStore(':memory:');
    try {
      const plugin = new StateMgmtPlugin();
      const ts = new TsLanguagePlugin();
      ts.registerVisitor(plugin.visitor);
      const handle = await ts.loadProject({ rootDir: fixturePath('basic') });

      const files = [
        'src/redux-store.ts',
        'src/zustand-store.ts',
        'src/mobx-store.ts',
        'src/pinia-store.ts',
        'src/dispatch-usage.ts',
      ];

      for (const file of files) {
        const batch = await ts.extractFile(handle, file);
        store.commit(batch, makeBatchMeta('ts'));
      }

      const allProcesses = store.findNodes('ClientSideProcess');
      expect(allProcesses.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
