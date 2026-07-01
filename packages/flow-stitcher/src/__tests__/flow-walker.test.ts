import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  idFor,
  type APIEndpoint,
  type CallsFunctionEdge,
  type ClientSideAPICaller,
  type ClientSideProcess,
  type DatabaseInteraction,
  type DatabaseSystem,
  type DatabaseTable,
  type DefinedInEdge,
  type FunctionDefinition,
  type PerformedByEdge,
  type ReadsEdge,
  type ResolvesToEndpointEdge,
  type SchemaEdge,
  type SchemaNode,
  type SourceFile,
  type WritesEdge,
} from '@adorable/schema';
import { makeBatchMeta } from '@adorable/plugin-api';
import { SQLiteCanonicalGraphStore } from '@adorable/graph-db';
import { createFlowWalker, stitchStore, FLOW_STITCHER_PRODUCER_ID } from '../index.js';

// ──────────────────────────────────────────────────────────────────────
// Seed builder — assembles a realistic React + Express + Prisma
// scenario in the canonical store so the walker has something to walk.
// ──────────────────────────────────────────────────────────────────────

interface SeedOptions {
  /** Include the client-side caller. */
  withCaller?: boolean;
  /** Include the RESOLVES_TO_ENDPOINT edge the stitcher would emit. */
  withResolve?: boolean;
  /** Include the server-side handler function. */
  withHandler?: boolean;
  /** Include the Prisma call (DatabaseInteraction + READS edge). */
  withDbInteraction?: boolean;
  /** Insert a helper function between the handler and the ORM call. */
  withServerHelper?: boolean;
  /** Insert a helper function between the React component and the fetch caller. */
  withClientHelper?: boolean;
}

interface Seed {
  process: ClientSideProcess;
  clientFn: FunctionDefinition;
  clientHelperFn: FunctionDefinition | null;
  caller: ClientSideAPICaller | null;
  endpoint: APIEndpoint;
  handlerFn: FunctionDefinition | null;
  serverHelperFn: FunctionDefinition | null;
  interaction: DatabaseInteraction | null;
  table: DatabaseTable;
  system: DatabaseSystem;
}

function seedStore(store: SQLiteCanonicalGraphStore, opts: SeedOptions = {}): Seed {
  const {
    withCaller = true,
    withResolve = true,
    withHandler = true,
    withDbInteraction = true,
    withServerHelper = false,
    withClientHelper = false,
  } = opts;

  const repo = 'flow-walker-test';
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];

  // ── Client side ─────────────────────────────────────────────────
  const clientFileId = idFor.sourceFile({ repository: repo, filePath: 'src/Users.tsx' });
  const clientFile: SourceFile = {
    nodeType: 'SourceFile',
    id: clientFileId,
    filePath: 'src/Users.tsx',
    repository: repo,
    language: 'ts',
    framework: null,
  };
  nodes.push(clientFile);

  const clientFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: clientFileId, name: 'UsersPage', sourceLine: 10 }),
    name: 'UsersPage',
    sourceFileId: clientFileId,
    sourceLine: 10,
    parameters: [],
    returnType: 'JSX.Element',
    isExported: true,
    isAsync: false,
  };
  nodes.push(clientFn);
  edges.push({ edgeType: 'DEFINED_IN', from: clientFn.id, to: clientFileId } as DefinedInEdge);

  const process: ClientSideProcess = {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({
      sourceFileId: clientFileId,
      sourceLine: 15,
      name: 'onClick',
    }),
    kind: 'event_handler',
    name: 'onClick',
    functionId: clientFn.id,
    sourceFileId: clientFileId,
    sourceLine: 15,
    framework: 'react',
    repository: repo,
  };
  nodes.push(process);

  let clientHelperFn: FunctionDefinition | null = null;
  if (withClientHelper) {
    clientHelperFn = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({
        sourceFileId: clientFileId,
        name: 'loadUsers',
        sourceLine: 30,
      }),
      name: 'loadUsers',
      sourceFileId: clientFileId,
      sourceLine: 30,
      parameters: [],
      returnType: 'Promise<unknown>',
      isExported: false,
      isAsync: true,
    };
    nodes.push(clientHelperFn);
    edges.push({ edgeType: 'DEFINED_IN', from: clientHelperFn.id, to: clientFileId } as DefinedInEdge);
    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: clientFn.id,
      to: clientHelperFn.id,
      sourceLine: 16,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    } as CallsFunctionEdge);
  }

  let caller: ClientSideAPICaller | null = null;
  if (withCaller) {
    // Attribute the caller to either the client helper (if present) or the main component.
    const callerEnclosing = clientHelperFn ?? clientFn;
    caller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId: clientFileId,
        sourceLine: 35,
        urlLiteral: '/api/users',
      }),
      functionId: callerEnclosing.id,
      sourceFileId: clientFileId,
      sourceLine: 35,
      httpMethod: 'GET',
      urlLiteral: '/api/users',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: repo,
    };
    nodes.push(caller);
  }

  // ── Server side ─────────────────────────────────────────────────
  const serverFileId = idFor.sourceFile({ repository: repo, filePath: 'src/server.ts' });
  const serverFile: SourceFile = {
    nodeType: 'SourceFile',
    id: serverFileId,
    filePath: 'src/server.ts',
    repository: repo,
    language: 'ts',
    framework: null,
  };
  nodes.push(serverFile);

  let handlerFn: FunctionDefinition | null = null;
  if (withHandler) {
    handlerFn = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({
        sourceFileId: serverFileId,
        name: 'listUsersHandler',
        sourceLine: 20,
      }),
      name: 'listUsersHandler',
      sourceFileId: serverFileId,
      sourceLine: 20,
      parameters: [],
      returnType: 'Promise<void>',
      isExported: true,
      isAsync: true,
    };
    nodes.push(handlerFn);
    edges.push({ edgeType: 'DEFINED_IN', from: handlerFn.id, to: serverFileId } as DefinedInEdge);
  }

  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({ repository: repo, httpMethod: 'GET', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
    httpMethod: 'GET',
    routePattern: '/api/users',
    handlerFunctionId: handlerFn?.id ?? null,
    framework: 'express',
    repository: repo,
  };
  nodes.push(endpoint);

  let serverHelperFn: FunctionDefinition | null = null;
  if (withServerHelper && handlerFn) {
    serverHelperFn = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({
        sourceFileId: serverFileId,
        name: 'userService',
        sourceLine: 40,
      }),
      name: 'userService',
      sourceFileId: serverFileId,
      sourceLine: 40,
      parameters: [],
      returnType: 'Promise<unknown[]>',
      isExported: true,
      isAsync: true,
    };
    nodes.push(serverHelperFn);
    edges.push({ edgeType: 'DEFINED_IN', from: serverHelperFn.id, to: serverFileId } as DefinedInEdge);
    edges.push({
      edgeType: 'CALLS_FUNCTION',
      from: handlerFn.id,
      to: serverHelperFn.id,
      sourceLine: 22,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    } as CallsFunctionEdge);
  }

  // ── Database ────────────────────────────────────────────────────
  const system: DatabaseSystem = {
    nodeType: 'DatabaseSystem',
    id: idFor.databaseSystem({ kind: 'postgres', name: 'db' }),
    kind: 'postgres',
    name: 'db',
    connectionSource: 'env("DATABASE_URL")',
  };
  nodes.push(system);

  const table: DatabaseTable = {
    nodeType: 'DatabaseTable',
    id: idFor.databaseTable({ systemId: system.id, schema: null, name: 'User' }),
    systemId: system.id,
    name: 'User',
    schema: null,
    kind: 'table',
    declaredIn: 'prisma/schema.prisma',
  };
  nodes.push(table);

  let interaction: DatabaseInteraction | null = null;
  if (withDbInteraction && handlerFn) {
    // Attribute the interaction to either the server helper (if present)
    // or the handler.
    const interactionCallSite = serverHelperFn ?? handlerFn;
    interaction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: interactionCallSite.id,
        operation: 'read',
        targetTableId: table.id,
      }),
      callSiteFunctionId: interactionCallSite.id,
      operation: 'read',
      orm: 'prisma',
      rawQuery: null,
      confidence: 'direct',
    };
    nodes.push(interaction);
    edges.push({
      edgeType: 'READS',
      from: interaction.id,
      to: table.id,
      columns: null,
      filters: null,
    } as ReadsEdge);
    edges.push({
      edgeType: 'PERFORMED_BY',
      from: interaction.id,
      to: interactionCallSite.id,
      sourceLine: 45,
    } as PerformedByEdge);
  }

  // ── Commit everything ───────────────────────────────────────────
  store.commit({ nodes, edges }, makeBatchMeta('test-seed'));

  // ── Stitcher edge (normally produced by PR 1) ───────────────────
  if (withResolve && caller) {
    store.commit(
      {
        nodes: [],
        edges: [
          {
            edgeType: 'RESOLVES_TO_ENDPOINT',
            from: caller.id,
            to: endpoint.id,
            matchedBy: 'exact-url',
            matchConfidence: 'high',
          } as ResolvesToEndpointEdge,
        ],
      },
      makeBatchMeta(FLOW_STITCHER_PRODUCER_ID)
    );
  }

  return {
    process,
    clientFn,
    clientHelperFn,
    caller,
    endpoint,
    handlerFn,
    serverHelperFn,
    interaction,
    table,
    system,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

let store: SQLiteCanonicalGraphStore;

beforeEach(() => {
  store = new SQLiteCanonicalGraphStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('complete flow', () => {
  it('walks from a React process all the way to a DatabaseTable', () => {
    const seed = seedStore(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.completeness).toBe('complete');
    expect(flow.startProcess.id).toBe(seed.process.id);
    expect(flow.startFunction?.id).toBe(seed.clientFn.id);
    expect(flow.caller?.id).toBe(seed.caller!.id);
    expect(flow.endpoint?.id).toBe(seed.endpoint.id);
    expect(flow.matchConfidence).toBe('high');
    expect(flow.matchedBy).toBe('exact-url');
    expect(flow.handlerFunction?.id).toBe(seed.handlerFn!.id);
    expect(flow.databaseHops).toHaveLength(1);
    expect(flow.databaseHops[0].interaction.id).toBe(seed.interaction!.id);
    expect(flow.databaseHops[0].readsTable?.id).toBe(seed.table.id);
    expect(flow.databaseHops[0].writesTable).toBeNull();
  });

  it('walks across client-side helper functions via CALLS_FUNCTION', () => {
    const seed = seedStore(store, { withClientHelper: true });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('complete');
    // The caller's functionId is the helper, not the component —
    // verify the walker found it via the call graph.
    expect(flows[0].caller?.functionId).toBe(seed.clientHelperFn!.id);
  });

  it('walks across server-side helper functions via CALLS_FUNCTION', () => {
    const seed = seedStore(store, { withServerHelper: true });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('complete');
    // The interaction's callSiteFunctionId is the server helper, not
    // the handler — verify the walker found it via the call graph.
    expect(flows[0].databaseHops[0].interaction.callSiteFunctionId).toBe(
      seed.serverHelperFn!.id
    );
  });

  it('walks through BOTH client and server helper chains', () => {
    const seed = seedStore(store, { withClientHelper: true, withServerHelper: true });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('complete');
    expect(flows[0].caller?.functionId).toBe(seed.clientHelperFn!.id);
    expect(flows[0].databaseHops[0].interaction.callSiteFunctionId).toBe(
      seed.serverHelperFn!.id
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Gap handling
// ──────────────────────────────────────────────────────────────────────

describe('gap handling', () => {
  it('returns process-only when the enclosing function is missing', () => {
    const seed = seedStore(store);
    // Replace the process with one whose functionId points at nothing.
    const orphanProcess: ClientSideProcess = {
      ...seed.process,
      id: 'ClientSideProcess:orphan',
      functionId: 'FunctionDefinition:ghost',
    };
    store.commit({ nodes: [orphanProcess], edges: [] }, makeBatchMeta('test'));
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(orphanProcess.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('process-only');
    expect(flows[0].startFunction).toBeNull();
  });

  it('returns function-only when no caller is reachable from the process function', () => {
    const seed = seedStore(store, { withCaller: false });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('function-only');
    expect(flows[0].caller).toBeNull();
  });

  it('returns caller-only when the caller has no RESOLVES_TO_ENDPOINT edge', () => {
    const seed = seedStore(store, { withResolve: false });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('caller-only');
    expect(flows[0].caller?.id).toBe(seed.caller!.id);
    expect(flows[0].endpoint).toBeNull();
  });

  it('returns endpoint-only when the endpoint has no handlerFunctionId', () => {
    const seed = seedStore(store, { withHandler: false });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('endpoint-only');
    expect(flows[0].endpoint?.id).toBe(seed.endpoint.id);
    expect(flows[0].handlerFunction).toBeNull();
  });

  it('returns handler-only when the handler has no reachable DatabaseInteraction', () => {
    const seed = seedStore(store, { withDbInteraction: false });
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('handler-only');
    expect(flows[0].handlerFunction?.id).toBe(seed.handlerFn!.id);
    expect(flows[0].databaseHops).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Walker entry points + scale
// ──────────────────────────────────────────────────────────────────────

describe('walker entry points', () => {
  it('walkFromProcess returns an empty array for an unknown process id', () => {
    const walker = createFlowWalker(store);
    expect(walker.walkFromProcess('ClientSideProcess:nope')).toEqual([]);
  });

  it('walkAllProcesses walks every process in the store', () => {
    seedStore(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    expect(flows.length).toBeGreaterThan(0);
    expect(flows[0].completeness).toBe('complete');
  });

  it('walkAllProcesses on an empty store returns an empty array', () => {
    const walker = createFlowWalker(store);
    expect(walker.walkAllProcesses()).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Ambiguity + multi-match
// ──────────────────────────────────────────────────────────────────────

describe('ambiguity and multi-match', () => {
  it('one caller resolving to two endpoints produces one flow per endpoint', () => {
    const seed = seedStore(store);
    // Add a second endpoint and a second RESOLVES_TO_ENDPOINT edge
    // from the same caller.
    const repo = seed.endpoint.repository;
    const otherEndpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: repo,
        httpMethod: 'GET',
        routePattern: '/api/users/:id',
        filePath: 'a.ts',
        lineStart: 1,
      }),
      httpMethod: 'GET',
      routePattern: '/api/users/:id',
      handlerFunctionId: null,
      framework: 'express',
      repository: repo,
    };
    store.commit(
      {
        nodes: [otherEndpoint],
        edges: [
          {
            edgeType: 'RESOLVES_TO_ENDPOINT',
            from: seed.caller!.id,
            to: otherEndpoint.id,
            matchedBy: 'inferred',
            matchConfidence: 'low',
          } as ResolvesToEndpointEdge,
        ],
      },
      makeBatchMeta('test')
    );

    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(2);
    const completeness = flows.map((f) => f.completeness).sort();
    // One flow reaches the complete handler; the other stops at
    // endpoint-only because the second endpoint has no handler.
    expect(completeness).toEqual(['complete', 'endpoint-only']);
  });

  it('one process triggering two callers produces one flow per caller', () => {
    const seed = seedStore(store);
    // Add a second caller in the same enclosing function.
    const secondCaller: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId: seed.caller!.sourceFileId,
        sourceLine: 50,
        urlLiteral: '/api/orders',
      }),
      functionId: seed.clientFn.id,
      sourceFileId: seed.caller!.sourceFileId,
      sourceLine: 50,
      httpMethod: 'GET',
      urlLiteral: '/api/orders',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: seed.endpoint.repository,
    };
    store.commit({ nodes: [secondCaller], edges: [] }, makeBatchMeta('test'));

    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    // One flow for the original caller (complete) and one for the
    // new caller (caller-only — no RESOLVES_TO_ENDPOINT emitted).
    expect(flows).toHaveLength(2);
    expect(flows.filter((f) => f.completeness === 'complete')).toHaveLength(1);
    expect(flows.filter((f) => f.completeness === 'caller-only')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Depth limiting and cycles
// ──────────────────────────────────────────────────────────────────────

describe('depth limiting and cycles', () => {
  it('respects maxCallDepth on the client side', () => {
    // Build a chain: clientFn → helper1 → helper2 → caller
    // With maxCallDepth=1, we should only reach helper1 and NOT
    // find the caller (which is attached to helper2).
    const seed = seedStore(store, { withCaller: false });
    const repo = seed.endpoint.repository;
    const sourceFileId = seed.clientFn.sourceFileId;

    const helper1: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: 'helper1', sourceLine: 100 }),
      name: 'helper1',
      sourceFileId,
      sourceLine: 100,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
    };
    const helper2: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: 'helper2', sourceLine: 110 }),
      name: 'helper2',
      sourceFileId,
      sourceLine: 110,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
    };
    const deepCaller: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId,
        sourceLine: 115,
        urlLiteral: '/api/users',
      }),
      functionId: helper2.id,
      sourceFileId,
      sourceLine: 115,
      httpMethod: 'GET',
      urlLiteral: '/api/users',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: repo,
    };
    store.commit(
      {
        nodes: [helper1, helper2, deepCaller],
        edges: [
          {
            edgeType: 'CALLS_FUNCTION',
            from: seed.clientFn.id,
            to: helper1.id,
            sourceLine: 11,
            arguments: [],
            isConditional: false,
            confidence: 'direct',
          } as CallsFunctionEdge,
          {
            edgeType: 'CALLS_FUNCTION',
            from: helper1.id,
            to: helper2.id,
            sourceLine: 101,
            arguments: [],
            isConditional: false,
            confidence: 'direct',
          } as CallsFunctionEdge,
        ],
      },
      makeBatchMeta('test')
    );

    const tightWalker = createFlowWalker(store, { maxCallDepth: 1 });
    const tightFlows = tightWalker.walkFromProcess(seed.process.id);
    // At depth 1, we can only see helper1 — the caller is attached
    // to helper2 (depth 2), so it's unreachable.
    expect(tightFlows).toHaveLength(1);
    expect(tightFlows[0].completeness).toBe('function-only');

    const looseWalker = createFlowWalker(store, { maxCallDepth: 10 });
    const looseFlows = looseWalker.walkFromProcess(seed.process.id);
    expect(looseFlows).toHaveLength(1);
    expect(looseFlows[0].caller?.id).toBe(deepCaller.id);
  });

  it('breaks cycles in the client-side call graph', () => {
    const seed = seedStore(store, { withCaller: false });
    const sourceFileId = seed.clientFn.sourceFileId;

    const cyclic: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name: 'cyclic', sourceLine: 200 }),
      name: 'cyclic',
      sourceFileId,
      sourceLine: 200,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
    };
    store.commit(
      {
        nodes: [cyclic],
        edges: [
          {
            edgeType: 'CALLS_FUNCTION',
            from: seed.clientFn.id,
            to: cyclic.id,
            sourceLine: 11,
            arguments: [],
            isConditional: false,
            confidence: 'direct',
          } as CallsFunctionEdge,
          // cyclic → cyclic (self-loop)
          {
            edgeType: 'CALLS_FUNCTION',
            from: cyclic.id,
            to: cyclic.id,
            sourceLine: 201,
            arguments: [],
            isConditional: false,
            confidence: 'direct',
          } as CallsFunctionEdge,
          // cyclic → clientFn (back edge)
          {
            edgeType: 'CALLS_FUNCTION',
            from: cyclic.id,
            to: seed.clientFn.id,
            sourceLine: 202,
            arguments: [],
            isConditional: false,
            confidence: 'direct',
          } as CallsFunctionEdge,
        ],
      },
      makeBatchMeta('test')
    );

    // Should not infinite-loop. Should terminate and return function-only.
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('function-only');
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: stitchStore → walk
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Additional edge cases (review round 2)
// ──────────────────────────────────────────────────────────────────────

describe('additional edge cases', () => {
  it('maxCallDepth: 0 visits only the root function', () => {
    // With maxCallDepth 0, no CALLS_FUNCTION edges are followed. A
    // caller attached directly to the start function is still found
    // (because the start function itself is in the visited set), but
    // a caller attached to any helper is not.
    const seed = seedStore(store, { withClientHelper: true });
    const walker = createFlowWalker(store, { maxCallDepth: 0 });
    const flows = walker.walkFromProcess(seed.process.id);
    // Caller was attributed to the helper, so it's unreachable at depth 0.
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('function-only');
  });

  it('maxCallDepth: 0 still finds a caller attached directly to the start function', () => {
    // Default seed: caller.functionId === clientFn.id
    const seed = seedStore(store);
    const walker = createFlowWalker(store, { maxCallDepth: 0 });
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].caller?.id).toBe(seed.caller!.id);
  });

  it('handles a 100-node linear call chain with a large maxCallDepth', () => {
    const seed = seedStore(store, { withCaller: false });
    const sourceFileId = seed.clientFn.sourceFileId;
    const nodes: SchemaNode[] = [];
    const edges: SchemaEdge[] = [];
    let prevId = seed.clientFn.id;
    for (let i = 0; i < 100; i++) {
      const fn: FunctionDefinition = {
        nodeType: 'FunctionDefinition',
        id: idFor.functionDefinition({
          sourceFileId,
          name: `chain${i}`,
          sourceLine: 1000 + i,
        }),
        name: `chain${i}`,
        sourceFileId,
        sourceLine: 1000 + i,
        parameters: [],
        returnType: null,
        isExported: false,
        isAsync: false,
      };
      nodes.push(fn);
      edges.push({
        edgeType: 'CALLS_FUNCTION',
        from: prevId,
        to: fn.id,
        sourceLine: 1000 + i,
        arguments: [],
        isConditional: false,
        confidence: 'direct',
      } as CallsFunctionEdge);
      prevId = fn.id;
    }
    // Attach a caller to the deepest function.
    const deepCaller: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId,
        sourceLine: 1200,
        urlLiteral: '/api/users',
      }),
      functionId: prevId,
      sourceFileId,
      sourceLine: 1200,
      httpMethod: 'GET',
      urlLiteral: '/api/users',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: seed.endpoint.repository,
    };
    nodes.push(deepCaller);
    store.commit({ nodes, edges }, makeBatchMeta('test'));

    const walker = createFlowWalker(store, { maxCallDepth: Number.MAX_SAFE_INTEGER });
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].caller?.id).toBe(deepCaller.id);
  });

  it('breaks diamond patterns (two paths to the same helper)', () => {
    // clientFn → left → shared
    //        ↘ right ↗
    const seed = seedStore(store, { withCaller: false });
    const sourceFileId = seed.clientFn.sourceFileId;

    const mk = (name: string, line: number): FunctionDefinition => ({
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId, name, sourceLine: line }),
      name,
      sourceFileId,
      sourceLine: line,
      parameters: [],
      returnType: null,
      isExported: false,
      isAsync: false,
    });
    const left = mk('left', 300);
    const right = mk('right', 310);
    const shared = mk('shared', 320);

    const callsEdge = (from: string, to: string, line: number): CallsFunctionEdge => ({
      edgeType: 'CALLS_FUNCTION',
      from,
      to,
      sourceLine: line,
      arguments: [],
      isConditional: false,
      confidence: 'direct',
    });

    const diamondCaller: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({
        sourceFileId,
        sourceLine: 325,
        urlLiteral: '/api/users',
      }),
      functionId: shared.id,
      sourceFileId,
      sourceLine: 325,
      httpMethod: 'GET',
      urlLiteral: '/api/users',
      egressConfidence: 'exact',
      framework: 'fetch',
      repository: seed.endpoint.repository,
    };

    store.commit(
      {
        nodes: [left, right, shared, diamondCaller],
        edges: [
          callsEdge(seed.clientFn.id, left.id, 11),
          callsEdge(seed.clientFn.id, right.id, 12),
          callsEdge(left.id, shared.id, 301),
          callsEdge(right.id, shared.id, 311),
        ],
      },
      makeBatchMeta('test')
    );

    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    // One caller → one flow, despite two graph paths reaching `shared`.
    expect(flows).toHaveLength(1);
    expect(flows[0].caller?.id).toBe(diamondCaller.id);
  });

  it('propagates matchConfidence/matchedBy when the endpoint has been deleted', () => {
    // Resolve edge exists but points at a non-existent endpoint id.
    const seed = seedStore(store, { withResolve: false });
    store.commit(
      {
        nodes: [],
        edges: [
          {
            edgeType: 'RESOLVES_TO_ENDPOINT',
            from: seed.caller!.id,
            to: 'APIEndpoint:ghost',
            matchedBy: 'inferred',
            matchConfidence: 'low',
          } as ResolvesToEndpointEdge,
        ],
      },
      makeBatchMeta(FLOW_STITCHER_PRODUCER_ID)
    );
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('caller-only');
    expect(flows[0].endpoint).toBeNull();
    expect(flows[0].matchConfidence).toBe('low');
    expect(flows[0].matchedBy).toBe('inferred');
  });

  it('reaches complete for a raw-query interaction with no READS/WRITES edge', () => {
    // Seed without the standard interaction, then add a raw one.
    const seed = seedStore(store, { withDbInteraction: false });
    const rawInteraction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: seed.handlerFn!.id,
        operation: 'raw',
        targetTableId: null,
      }),
      callSiteFunctionId: seed.handlerFn!.id,
      operation: 'raw',
      orm: 'prisma',
      rawQuery: 'SELECT * FROM "User"',
      confidence: 'inferred',
    };
    store.commit(
      {
        nodes: [rawInteraction],
        edges: [
          {
            edgeType: 'PERFORMED_BY',
            from: rawInteraction.id,
            to: seed.handlerFn!.id,
            sourceLine: 99,
          } as PerformedByEdge,
        ],
      },
      makeBatchMeta('test')
    );
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('complete');
    expect(flows[0].databaseHops).toHaveLength(1);
    expect(flows[0].databaseHops[0].readsTable).toBeNull();
    expect(flows[0].databaseHops[0].writesTable).toBeNull();
  });

  it('records both read and write tables for an upsert interaction', () => {
    const seed = seedStore(store, { withDbInteraction: false });
    const upsert: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: seed.handlerFn!.id,
        operation: 'upsert',
        targetTableId: seed.table.id,
      }),
      callSiteFunctionId: seed.handlerFn!.id,
      operation: 'upsert',
      orm: 'prisma',
      rawQuery: null,
      confidence: 'direct',
    };
    store.commit(
      {
        nodes: [upsert],
        edges: [
          {
            edgeType: 'READS',
            from: upsert.id,
            to: seed.table.id,
            columns: null,
            filters: null,
          } as ReadsEdge,
          {
            edgeType: 'WRITES',
            from: upsert.id,
            to: seed.table.id,
            columns: null,
            kind: 'upsert',
          } as WritesEdge,
          {
            edgeType: 'PERFORMED_BY',
            from: upsert.id,
            to: seed.handlerFn!.id,
            sourceLine: 50,
          } as PerformedByEdge,
        ],
      },
      makeBatchMeta('test')
    );
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('complete');
    expect(flows[0].databaseHops[0].readsTable?.id).toBe(seed.table.id);
    expect(flows[0].databaseHops[0].writesTable?.id).toBe(seed.table.id);
  });

  it('only surfaces the first table for an interaction that reads multiple tables (known simplification)', () => {
    const seed = seedStore(store, { withDbInteraction: false });
    const otherTable: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: seed.system.id, schema: null, name: 'Order' }),
      systemId: seed.system.id,
      name: 'Order',
      schema: null,
      kind: 'table',
      declaredIn: 'prisma/schema.prisma',
    };
    const multi: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: seed.handlerFn!.id,
        operation: 'read',
        targetTableId: seed.table.id,
      }),
      callSiteFunctionId: seed.handlerFn!.id,
      operation: 'read',
      orm: 'prisma',
      rawQuery: null,
      confidence: 'direct',
    };
    store.commit(
      {
        nodes: [otherTable, multi],
        edges: [
          {
            edgeType: 'READS',
            from: multi.id,
            to: seed.table.id,
            columns: null,
            filters: null,
          } as ReadsEdge,
          {
            edgeType: 'READS',
            from: multi.id,
            to: otherTable.id,
            columns: null,
            filters: null,
          } as ReadsEdge,
          {
            edgeType: 'PERFORMED_BY',
            from: multi.id,
            to: seed.handlerFn!.id,
            sourceLine: 60,
          } as PerformedByEdge,
        ],
      },
      makeBatchMeta('test')
    );
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    // Exactly one hop, with exactly one of the two READS surfaced.
    // Pinning current behavior; follow-up should widen to an array.
    expect(flows[0].databaseHops).toHaveLength(1);
    expect(flows[0].databaseHops[0].readsTable).not.toBeNull();
  });

  it('returns endpoint-only when handlerFunctionId points at a missing function', () => {
    // Seed without a handler, then set the endpoint's handlerFunctionId
    // to a dangling id via a fresh APIEndpoint node (content-addressed
    // id makes this a distinct endpoint).
    const seed = seedStore(store, { withHandler: false, withResolve: false });
    const repo = seed.endpoint.repository;
    const danglingEndpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: repo,
        httpMethod: 'POST',
        routePattern: '/api/users',
        filePath: 'a.ts',
        lineStart: 1,
      }),
      httpMethod: 'POST',
      routePattern: '/api/users',
      handlerFunctionId: 'FunctionDefinition:ghost-handler',
      framework: 'express',
      repository: repo,
    };
    // Replace the caller's URL to match the new endpoint? Easier: emit
    // a RESOLVES_TO_ENDPOINT edge directly.
    store.commit(
      {
        nodes: [danglingEndpoint],
        edges: [
          {
            edgeType: 'RESOLVES_TO_ENDPOINT',
            from: seed.caller!.id,
            to: danglingEndpoint.id,
            matchedBy: 'exact-url',
            matchConfidence: 'high',
          } as ResolvesToEndpointEdge,
        ],
      },
      makeBatchMeta(FLOW_STITCHER_PRODUCER_ID)
    );
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    // Two resolve targets: the original (no handler → endpoint-only)
    // and the dangling one (ghost handler → also endpoint-only).
    const endpointOnly = flows.filter((f) => f.completeness === 'endpoint-only');
    expect(endpointOnly.length).toBeGreaterThanOrEqual(1);
    const dangling = flows.find((f) => f.endpoint?.id === danglingEndpoint.id);
    expect(dangling?.completeness).toBe('endpoint-only');
    expect(dangling?.handlerFunction).toBeNull();
  });

  it('attributes a shared caller to each process that reaches it independently', () => {
    const seed = seedStore(store);
    // Add a second process in the same enclosing function.
    const process2: ClientSideProcess = {
      ...seed.process,
      id: idFor.clientSideProcess({
        sourceFileId: seed.process.sourceFileId,
        sourceLine: 16,
        name: 'onSubmit',
      }),
      name: 'onSubmit',
      sourceLine: 16,
    };
    store.commit({ nodes: [process2], edges: [] }, makeBatchMeta('test'));

    const walker = createFlowWalker(store);
    const flowsA = walker.walkFromProcess(seed.process.id);
    const flowsB = walker.walkFromProcess(process2.id);
    expect(flowsA).toHaveLength(1);
    expect(flowsB).toHaveLength(1);
    expect(flowsA[0].startProcess.id).toBe(seed.process.id);
    expect(flowsB[0].startProcess.id).toBe(process2.id);
    // Both reach the same caller.
    expect(flowsA[0].caller?.id).toBe(seed.caller!.id);
    expect(flowsB[0].caller?.id).toBe(seed.caller!.id);
  });

  it('walkFromProcess with a non-ClientSideProcess id returns an empty array', () => {
    const seed = seedStore(store);
    const walker = createFlowWalker(store);
    // Pass the FunctionDefinition id — getNode is type-checked and
    // should return null because the nodeType does not match.
    expect(walker.walkFromProcess(seed.clientFn.id)).toEqual([]);
  });

  it('is idempotent: two walks from the same process return equivalent flows', () => {
    const seed = seedStore(store);
    const walker = createFlowWalker(store);
    const first = walker.walkFromProcess(seed.process.id);
    const second = walker.walkFromProcess(seed.process.id);
    expect(second).toHaveLength(first.length);
    expect(second[0].completeness).toBe(first[0].completeness);
    expect(second[0].startProcess.id).toBe(first[0].startProcess.id);
    expect(second[0].caller?.id).toBe(first[0].caller?.id);
    expect(second[0].endpoint?.id).toBe(first[0].endpoint?.id);
    expect(second[0].databaseHops[0]?.interaction.id).toBe(
      first[0].databaseHops[0]?.interaction.id
    );
  });
});

describe('end-to-end: stitchStore + walk', () => {
  it('runs the stitcher first, then walks, and produces a complete flow', () => {
    // Seed everything EXCEPT the stitcher edge.
    const seed = seedStore(store, { withResolve: false });

    // Run the stitcher to produce the RESOLVES_TO_ENDPOINT edge.
    const stitchBatch = stitchStore(store);
    store.commit(stitchBatch, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));

    // Now walk.
    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    expect(flows).toHaveLength(1);
    expect(flows[0].completeness).toBe('complete');
    expect(flows[0].endpoint?.id).toBe(seed.endpoint.id);
    expect(flows[0].databaseHops[0].readsTable?.id).toBe(seed.table.id);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-table database hops (#87)
// ──────────────────────────────────────────────────────────────────────

describe('multi-table database hops', () => {
  it('a single interaction with multiple READS edges surfaces all tables in readsTables', () => {
    const seed = seedStore(store);
    // Add a second table and a second READS edge from the same interaction.
    const ordersTable: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: seed.system.id, schema: null, name: 'Order' }),
      systemId: seed.system.id,
      name: 'Order',
      schema: null,
      kind: 'table',
      declaredIn: 'prisma/schema.prisma',
    };
    const secondReads: ReadsEdge = {
      edgeType: 'READS',
      from: seed.interaction!.id,
      to: ordersTable.id,
      columns: null,
      filters: null,
    };
    store.commit(
      { nodes: [ordersTable], edges: [secondReads] },
      makeBatchMeta('test')
    );

    const walker = createFlowWalker(store);
    const flows = walker.walkFromProcess(seed.process.id);
    const complete = flows.filter((f) => f.completeness === 'complete');
    expect(complete.length).toBeGreaterThan(0);

    const hop = complete[0].databaseHops[0];
    expect(hop.readsTables).toHaveLength(2);
    expect(hop.readsTables.map((t) => t.name).sort()).toEqual(['Order', 'User']);
    // Backwards-compatible single accessor still returns the first table
    expect(hop.readsTable).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-hop flow walking (#137)
// ──────────────────────────────────────────────────────────────────────

/**
 * Seed a 3-service scenario:
 *   web (React) → gateway (Express) → user-service (NestJS + DB)
 */
function seedMultiHopStore(store: SQLiteCanonicalGraphStore) {
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];

  // ── Web (frontend) ─────────────────────────────────────────────
  const webFileId = idFor.sourceFile({ repository: 'web', filePath: 'src/App.tsx' });
  nodes.push({ nodeType: 'SourceFile', id: webFileId, filePath: 'src/App.tsx', repository: 'web', language: 'ts', framework: null } as SourceFile);

  const webFn: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: webFileId, name: 'App', sourceLine: 5 }),
    name: 'App', sourceFileId: webFileId, sourceLine: 5,
    parameters: [], returnType: 'JSX.Element', isExported: true, isAsync: false,
  };
  nodes.push(webFn);
  edges.push({ edgeType: 'DEFINED_IN', from: webFn.id, to: webFileId } as DefinedInEdge);

  const process: ClientSideProcess = {
    nodeType: 'ClientSideProcess',
    id: idFor.clientSideProcess({ sourceFileId: webFileId, sourceLine: 10, name: 'onClick' }),
    kind: 'event_handler', name: 'onClick', functionId: webFn.id,
    sourceFileId: webFileId, sourceLine: 10, framework: 'react', repository: 'web',
  };
  nodes.push(process);

  const webCaller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({ sourceFileId: webFileId, sourceLine: 15, urlLiteral: '/api/users' }),
    functionId: webFn.id, sourceFileId: webFileId, sourceLine: 15,
    httpMethod: 'POST', urlLiteral: '/api/users', egressConfidence: 'exact',
    framework: 'fetch', repository: 'web',
  };
  nodes.push(webCaller);

  // ── Gateway ────────────────────────────────────────────────────
  const gwFileId = idFor.sourceFile({ repository: 'gateway', filePath: 'src/routes.ts' });
  nodes.push({ nodeType: 'SourceFile', id: gwFileId, filePath: 'src/routes.ts', repository: 'gateway', language: 'ts', framework: null } as SourceFile);

  const gwHandler: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: gwFileId, name: 'proxyCreateUser', sourceLine: 10 }),
    name: 'proxyCreateUser', sourceFileId: gwFileId, sourceLine: 10,
    parameters: [], returnType: 'Promise<void>', isExported: true, isAsync: true,
  };
  nodes.push(gwHandler);
  edges.push({ edgeType: 'DEFINED_IN', from: gwHandler.id, to: gwFileId } as DefinedInEdge);

  const gwEndpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({ repository: 'gateway', httpMethod: 'POST', routePattern: '/api/users', filePath: 'a.ts', lineStart: 1 }),
    httpMethod: 'POST', routePattern: '/api/users',
    handlerFunctionId: gwHandler.id, framework: 'express', repository: 'gateway',
  };
  nodes.push(gwEndpoint);

  // Gateway makes an outbound call to user-service
  const gwCaller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({ sourceFileId: gwFileId, sourceLine: 20, urlLiteral: '/users' }),
    functionId: gwHandler.id, sourceFileId: gwFileId, sourceLine: 20,
    httpMethod: 'POST', urlLiteral: '/users', egressConfidence: 'exact',
    framework: 'fetch', repository: 'gateway',
  };
  nodes.push(gwCaller);

  // ── User Service ───────────────────────────────────────────────
  const usFileId = idFor.sourceFile({ repository: 'user-service', filePath: 'src/users.controller.ts' });
  nodes.push({ nodeType: 'SourceFile', id: usFileId, filePath: 'src/users.controller.ts', repository: 'user-service', language: 'ts', framework: null } as SourceFile);

  const usHandler: FunctionDefinition = {
    nodeType: 'FunctionDefinition',
    id: idFor.functionDefinition({ sourceFileId: usFileId, name: 'UsersController.create', sourceLine: 15 }),
    name: 'UsersController.create', sourceFileId: usFileId, sourceLine: 15,
    parameters: [], returnType: 'Promise<void>', isExported: true, isAsync: true,
  };
  nodes.push(usHandler);
  edges.push({ edgeType: 'DEFINED_IN', from: usHandler.id, to: usFileId } as DefinedInEdge);

  const usEndpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({ repository: 'user-service', httpMethod: 'POST', routePattern: '/users', filePath: 'a.ts', lineStart: 1 }),
    httpMethod: 'POST', routePattern: '/users',
    handlerFunctionId: usHandler.id, framework: 'nestjs', repository: 'user-service',
  };
  nodes.push(usEndpoint);

  // Database in user-service
  const system: DatabaseSystem = {
    nodeType: 'DatabaseSystem',
    id: idFor.databaseSystem({ kind: 'mongodb', name: 'users-db' }),
    kind: 'mongodb', name: 'users-db', connectionSource: 'env("MONGO_URL")',
  };
  nodes.push(system);

  const table: DatabaseTable = {
    nodeType: 'DatabaseTable',
    id: idFor.databaseTable({ systemId: system.id, schema: null, name: 'users' }),
    systemId: system.id, name: 'users', schema: null, kind: 'collection', declaredIn: null,
  };
  nodes.push(table);

  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({ callSiteFunctionId: usHandler.id, operation: 'write', targetTableId: table.id }),
    callSiteFunctionId: usHandler.id, operation: 'write', orm: 'mongoose', rawQuery: null, confidence: 'direct',
  };
  nodes.push(interaction);
  edges.push({ edgeType: 'WRITES', from: interaction.id, to: table.id, columns: null, kind: 'insert' } as WritesEdge);
  edges.push({ edgeType: 'PERFORMED_BY', from: interaction.id, to: usHandler.id, sourceLine: 20 } as PerformedByEdge);

  // Commit all nodes and edges
  store.commit({ nodes, edges }, makeBatchMeta('test-multihop'));

  // Stitch: web → gateway
  store.commit({
    nodes: [],
    edges: [{
      edgeType: 'RESOLVES_TO_ENDPOINT', from: webCaller.id, to: gwEndpoint.id,
      matchedBy: 'exact-url', matchConfidence: 'high',
    } as ResolvesToEndpointEdge],
  }, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));

  // Stitch: gateway → user-service
  store.commit({
    nodes: [],
    edges: [{
      edgeType: 'RESOLVES_TO_ENDPOINT', from: gwCaller.id, to: usEndpoint.id,
      matchedBy: 'exact-url', matchConfidence: 'high',
    } as ResolvesToEndpointEdge],
  }, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));

  return { process, webCaller, gwEndpoint, gwHandler, gwCaller, usEndpoint, usHandler, interaction, table };
}

describe('multi-hop flow walking (#137)', () => {
  it('with maxHops=1 (default), stops at gateway — no service hops', () => {
    const seed = seedMultiHopStore(store);
    const walker = createFlowWalker(store, { maxHops: 1 });
    const flows = walker.walkFromProcess(seed.process.id);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    // Gateway handler has no DB, but with maxHops=1 we don't follow downstream
    expect(flow.completeness).toBe('handler-only');
    expect(flow.serviceHops).toHaveLength(0);
    expect(flow.endpoint?.id).toBe(seed.gwEndpoint.id);
  });

  it('with maxHops=2, follows gateway → user-service and finds DB', () => {
    const seed = seedMultiHopStore(store);
    const walker = createFlowWalker(store, { maxHops: 2 });
    const flows = walker.walkFromProcess(seed.process.id);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.completeness).toBe('complete');
    expect(flow.endpoint?.id).toBe(seed.gwEndpoint.id);

    // Service hops should contain the user-service hop
    expect(flow.serviceHops).toHaveLength(1);
    const hop = flow.serviceHops[0];
    expect(hop.repository).toBe('user-service');
    expect(hop.endpoint.id).toBe(seed.usEndpoint.id);
    expect(hop.handlerFunction?.id).toBe(seed.usHandler.id);
    expect(hop.databaseHops).toHaveLength(1);
    expect(hop.databaseHops[0].writesTables[0].name).toBe('users');
    expect(hop.downstreamCalls).toHaveLength(0);
  });

  it('with maxHops=3, does not create extra hops when chain ends at 2', () => {
    const seed = seedMultiHopStore(store);
    const walker = createFlowWalker(store, { maxHops: 3 });
    const flows = walker.walkFromProcess(seed.process.id);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.completeness).toBe('complete');
    expect(flow.serviceHops).toHaveLength(1);
    expect(flow.serviceHops[0].downstreamCalls).toHaveLength(0);
  });

  it('detects endpoint-level cycles and stops', () => {
    const seed = seedMultiHopStore(store);

    // Add a circular call: user-service calls back to the SAME gateway endpoint
    // that initiated the chain (POST /api/users). This is an endpoint-level cycle.
    const usFileId = idFor.sourceFile({ repository: 'user-service', filePath: 'src/users.controller.ts' });
    const circularCaller: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({ sourceFileId: usFileId, sourceLine: 30, urlLiteral: '/api/users' }),
      functionId: seed.usHandler.id, sourceFileId: usFileId, sourceLine: 30,
      httpMethod: 'POST', urlLiteral: '/api/users', egressConfidence: 'exact',
      framework: 'fetch', repository: 'user-service',
    };
    store.commit({ nodes: [circularCaller], edges: [] }, makeBatchMeta('test-cycle'));
    store.commit({
      nodes: [],
      edges: [{
        edgeType: 'RESOLVES_TO_ENDPOINT', from: circularCaller.id, to: seed.gwEndpoint.id,
        matchedBy: 'exact-url', matchConfidence: 'high',
      } as ResolvesToEndpointEdge],
    }, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));

    const walker = createFlowWalker(store, { maxHops: 5 });
    const flows = walker.walkFromProcess(seed.process.id);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.serviceHops).toHaveLength(1);
    // The cycle back to the same gateway endpoint should be blocked
    expect(flow.serviceHops[0].downstreamCalls).toHaveLength(0);
  });

  it('handles fan-out: gateway calls two downstream services', () => {
    const seed = seedMultiHopStore(store);

    // Add a second downstream service: order-service
    const gwFileId = idFor.sourceFile({ repository: 'gateway', filePath: 'src/routes.ts' });
    const gwCaller2: ClientSideAPICaller = {
      nodeType: 'ClientSideAPICaller',
      id: idFor.clientSideAPICaller({ sourceFileId: gwFileId, sourceLine: 25, urlLiteral: '/orders' }),
      functionId: seed.gwHandler.id, sourceFileId: gwFileId, sourceLine: 25,
      httpMethod: 'POST', urlLiteral: '/orders', egressConfidence: 'exact',
      framework: 'fetch', repository: 'gateway',
    };

    const osFileId = idFor.sourceFile({ repository: 'order-service', filePath: 'src/orders.ts' });
    const osHandler: FunctionDefinition = {
      nodeType: 'FunctionDefinition',
      id: idFor.functionDefinition({ sourceFileId: osFileId, name: 'createOrder', sourceLine: 10 }),
      name: 'createOrder', sourceFileId: osFileId, sourceLine: 10,
      parameters: [], returnType: 'Promise<void>', isExported: true, isAsync: true,
    };
    const osEndpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({ repository: 'order-service', httpMethod: 'POST', routePattern: '/orders', filePath: 'a.ts', lineStart: 1 }),
      httpMethod: 'POST', routePattern: '/orders',
      handlerFunctionId: osHandler.id, framework: 'express', repository: 'order-service',
    };
    const osSystem: DatabaseSystem = {
      nodeType: 'DatabaseSystem',
      id: idFor.databaseSystem({ kind: 'postgres', name: 'orders-db' }),
      kind: 'postgres', name: 'orders-db', connectionSource: 'env("PG_URL")',
    };
    const osTable: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: idFor.databaseTable({ systemId: osSystem.id, schema: null, name: 'orders' }),
      systemId: osSystem.id, name: 'orders', schema: null, kind: 'table', declaredIn: null,
    };
    const osInteraction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({ callSiteFunctionId: osHandler.id, operation: 'write', targetTableId: osTable.id }),
      callSiteFunctionId: osHandler.id, operation: 'write', orm: 'prisma', rawQuery: null, confidence: 'direct',
    };

    store.commit({
      nodes: [
        { nodeType: 'SourceFile', id: osFileId, filePath: 'src/orders.ts', repository: 'order-service', language: 'ts', framework: null } as SourceFile,
        gwCaller2, osHandler, osEndpoint, osSystem, osTable, osInteraction,
      ],
      edges: [
        { edgeType: 'DEFINED_IN', from: osHandler.id, to: osFileId } as DefinedInEdge,
        { edgeType: 'WRITES', from: osInteraction.id, to: osTable.id, columns: null, kind: 'insert' } as WritesEdge,
        { edgeType: 'PERFORMED_BY', from: osInteraction.id, to: osHandler.id, sourceLine: 15 } as PerformedByEdge,
      ],
    }, makeBatchMeta('test-fanout'));

    store.commit({
      nodes: [],
      edges: [{
        edgeType: 'RESOLVES_TO_ENDPOINT', from: gwCaller2.id, to: osEndpoint.id,
        matchedBy: 'exact-url', matchConfidence: 'high',
      } as ResolvesToEndpointEdge],
    }, makeBatchMeta(FLOW_STITCHER_PRODUCER_ID));

    const walker = createFlowWalker(store, { maxHops: 2 });
    const flows = walker.walkFromProcess(seed.process.id);

    expect(flows).toHaveLength(1);
    const flow = flows[0];
    expect(flow.completeness).toBe('complete');
    // Two downstream service hops: user-service and order-service
    expect(flow.serviceHops).toHaveLength(2);
    const repos = flow.serviceHops.map((h) => h.repository).sort();
    expect(repos).toEqual(['order-service', 'user-service']);
    // Both should have DB interactions
    expect(flow.serviceHops.every((h) => h.databaseHops.length > 0)).toBe(true);
  });

  it('existing single-hop flows still have empty serviceHops array', () => {
    seedStore(store);
    const walker = createFlowWalker(store);
    const flows = walker.walkAllProcesses();
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      expect(flow.serviceHops).toEqual([]);
    }
  });
});
