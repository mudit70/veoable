import type {
  APIEndpoint,
  ClientSideAPICaller,
  ClientSideProcess,
  DatabaseInteraction,
  DatabaseTable,
  FunctionDefinition,
  NavigatesToEdge,
  ReadsEdge,
  ResolvesToEndpointEdge,
  Screen,
  WritesEdge,
} from '@veoable/schema';
import type { CanonicalGraphStore } from '@veoable/graph-db';
import type { Flow, FlowCompleteness, FlowDatabaseHop, FlowNavigationTarget, ServiceHop } from './flow-types.js';

/**
 * Flow walker — the query API that turns the stitched canonical
 * graph into structured end-to-end flows (#4 PR 2/2).
 *
 * Each flow is a single linear path from a `ClientSideProcess` down
 * to the database tables it ultimately reaches, via (optionally)
 * client callers, endpoints, and handler functions.
 *
 * Shape of a walk, starting from a process `P`:
 *
 *   1. Look up `P.functionId` → `startFunction`
 *   2. BFS the `CALLS_FUNCTION` graph from `startFunction` with a
 *      bounded depth, collecting every reachable function
 *   3. For every `ClientSideAPICaller` in the reachable set, look up
 *      its `RESOLVES_TO_ENDPOINT` edges (produced by PR 1's
 *      stitcher)
 *   4. For every resolved endpoint, look up `endpoint.handlerFunctionId`
 *      → `handlerFunction`
 *   5. BFS the `CALLS_FUNCTION` graph from `handlerFunction`,
 *      collecting every reachable function
 *   6. For every `DatabaseInteraction` in that reachable set (via
 *      `PERFORMED_BY` edges), look up its `READS` / `WRITES` edges to
 *      find the tables it touches
 *
 * One path → one `Flow`. A process that triggers two client callers
 * produces two flows; a caller that ambiguously matches two endpoints
 * produces two flows (one per endpoint hop). The UI groups flows by
 * `startProcess.id` for presentation.
 *
 * Gap handling: the walk never fails. It stops when it runs out of
 * edges to follow and records how far it got in `flow.completeness`.
 * A process with no reachable caller still produces a
 * `function-only` flow so the UI can show it.
 */

export interface FlowWalker {
  walkFromProcess(processId: string): Flow[];
  walkAllProcesses(): Flow[];
}

export interface FlowWalkerOptions {
  /**
   * Maximum depth for transitive `CALLS_FUNCTION` traversal on both
   * the client and server sides. Defaults to 10. Cycles are broken
   * via a visited set; this bound is an additional safety net for
   * huge acyclic call graphs.
   */
  maxCallDepth?: number;

  /**
   * Maximum number of service-to-service hops to follow (#137).
   * Defaults to 1 (current behavior — no multi-hop). Set to 2+ for
   * microservice architectures where a gateway forwards to downstream
   * services. Capped at 5 to prevent runaway traversal.
   */
  maxHops?: number;
}

export function createFlowWalker(
  store: CanonicalGraphStore,
  opts: FlowWalkerOptions = {}
): FlowWalker {
  const maxCallDepth = opts.maxCallDepth ?? 10;
  const maxHops = Math.min(opts.maxHops ?? 1, 5);

  return {
    walkFromProcess(processId: string): Flow[] {
      const process = store.getNode('ClientSideProcess', processId);
      if (!process) return [];
      return walkOneProcess(store, process, maxCallDepth, maxHops);
    },
    walkAllProcesses(): Flow[] {
      const processes = store.findNodes('ClientSideProcess');
      const flows: Flow[] = [];
      for (const process of processes) {
        flows.push(...walkOneProcess(store, process, maxCallDepth, maxHops));
      }
      return flows;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-process walk
// ──────────────────────────────────────────────────────────────────────

function walkOneProcess(
  store: CanonicalGraphStore,
  process: ClientSideProcess,
  maxCallDepth: number,
  maxHops: number
): Flow[] {
  // 1. Resolve the starting function.
  const startFunction = store.getNode('FunctionDefinition', process.functionId);
  if (!startFunction) {
    return [buildFlow({ process, completeness: 'process-only' })];
  }

  // 2. Scope-narrowed traversal: if the process has a TRIGGERS edge,
  //    start BFS from the specific callback function instead of the
  //    entire component function. This eliminates false positives
  //    where an onChange handler appears to reach a fetch() call that
  //    only the onSubmit handler actually invokes.
  const triggersEdges = store.findEdges(process.id, null, 'TRIGGERS');
  const bfsRoot = triggersEdges.length > 0 ? triggersEdges[0].to : startFunction.id;
  const reachableClientFunctions = bfsCallGraph(store, bfsRoot, maxCallDepth);

  // 2b. Find navigation targets (NAVIGATES_TO → Screen → component).
  const navigationTargets = findNavigationTargets(store, reachableClientFunctions);

  // 3. Find every ClientSideAPICaller whose functionId is in the
  //    reachable set.
  const reachableCallers = findCallersInFunctions(store, reachableClientFunctions);

  if (reachableCallers.length === 0) {
    return [buildFlow({ process, startFunction, navigationTargets, completeness: 'function-only' })];
  }

  const flows: Flow[] = [];

  for (const caller of reachableCallers) {
    // 4. Follow RESOLVES_TO_ENDPOINT edges out of this caller.
    const resolveEdges = store
      .findEdges(caller.id, null, 'RESOLVES_TO_ENDPOINT')
      .filter((e): e is ResolvesToEndpointEdge => e.edgeType === 'RESOLVES_TO_ENDPOINT');

    if (resolveEdges.length === 0) {
      flows.push(
        buildFlow({ process, startFunction, caller, navigationTargets, completeness: 'caller-only' })
      );
      continue;
    }

    for (const edge of resolveEdges) {
      const endpoint = store.getNode('APIEndpoint', edge.to);
      if (!endpoint) {
        flows.push(
          buildFlow({
            process,
            startFunction,
            caller,
            navigationTargets,
            completeness: 'caller-only',
            matchConfidence: edge.matchConfidence,
            matchedBy: edge.matchedBy,
          })
        );
        continue;
      }

      // 5. Follow the endpoint's handler function.
      if (!endpoint.handlerFunctionId) {
        flows.push(
          buildFlow({
            process,
            startFunction,
            caller,
            endpoint,
            navigationTargets,
            matchConfidence: edge.matchConfidence,
            matchedBy: edge.matchedBy,
            completeness: 'endpoint-only',
          })
        );
        continue;
      }

      const handlerFunction = store.getNode(
        'FunctionDefinition',
        endpoint.handlerFunctionId
      );
      if (!handlerFunction) {
        flows.push(
          buildFlow({
            process,
            startFunction,
            caller,
            endpoint,
            navigationTargets,
            matchConfidence: edge.matchConfidence,
            matchedBy: edge.matchedBy,
            completeness: 'endpoint-only',
          })
        );
        continue;
      }

      // 6. BFS the server-side call graph and find every reachable
      //    DatabaseInteraction + downstream service hops.
      const reachableServerFunctions = bfsCallGraph(
        store,
        handlerFunction.id,
        maxCallDepth
      );
      const dbHops = findDatabaseHops(store, reachableServerFunctions);

      // 7. Multi-hop: follow outbound API calls from the handler (#137).
      const visitedEndpoints = new Set<string>();
      visitedEndpoints.add(endpoint.id);
      const serviceHops = maxHops > 1
        ? walkServiceHops(store, reachableServerFunctions, maxCallDepth, maxHops - 1, visitedEndpoints)
        : [];

      const isComplete = dbHops.length > 0 || serviceHops.some(hasDbInteraction);

      if (!isComplete) {
        flows.push(
          buildFlow({
            process,
            startFunction,
            caller,
            endpoint,
            handlerFunction,
            navigationTargets,
            matchConfidence: edge.matchConfidence,
            matchedBy: edge.matchedBy,
            serviceHops,
            completeness: 'handler-only',
          })
        );
        continue;
      }

      flows.push(
        buildFlow({
          process,
          startFunction,
          caller,
          endpoint,
          handlerFunction,
          navigationTargets,
          matchConfidence: edge.matchConfidence,
          matchedBy: edge.matchedBy,
          databaseHops: dbHops,
          serviceHops,
          completeness: 'complete',
        })
      );
    }
  }

  return flows;
}

// ──────────────────────────────────────────────────────────────────────
// Multi-hop service walking (#137)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk downstream service hops from a set of reachable server functions.
 * For each function that makes an outbound API call (MAKES_REQUEST →
 * ClientSideAPICaller → RESOLVES_TO_ENDPOINT → APIEndpoint), follow
 * the hop recursively up to `remainingHops` depth.
 *
 * Cycle detection: tracks both visited endpoint IDs (prevents
 * revisiting the same endpoint) and visited repository names
 * (prevents A→B→A repo-level loops). Endpoint-level tracking
 * allows multiple hops within the same repo (monorepo services)
 * while repo-level tracking catches broader cycles.
 */
function walkServiceHops(
  store: CanonicalGraphStore,
  reachableFunctions: Set<string>,
  maxCallDepth: number,
  remainingHops: number,
  visitedEndpoints: Set<string>
): ServiceHop[] {
  if (remainingHops <= 0) return [];

  // Find outbound callers from the handler's call graph.
  const outboundCallers = findCallersInFunctions(store, reachableFunctions);
  const hops: ServiceHop[] = [];

  for (const caller of outboundCallers) {
    const resolveEdges = store
      .findEdges(caller.id, null, 'RESOLVES_TO_ENDPOINT')
      .filter((e): e is ResolvesToEndpointEdge => e.edgeType === 'RESOLVES_TO_ENDPOINT');

    for (const edge of resolveEdges) {
      const endpoint = store.getNode('APIEndpoint', edge.to);
      if (!endpoint) continue;

      // Cycle detection: skip if we've already visited this endpoint.
      if (visitedEndpoints.has(endpoint.id)) continue;

      const nextVisited = new Set(visitedEndpoints);
      nextVisited.add(endpoint.id);

      let handlerFunction: FunctionDefinition | null = null;
      let dbHops: FlowDatabaseHop[] = [];
      let downstreamCalls: ServiceHop[] = [];

      if (endpoint.handlerFunctionId) {
        handlerFunction = store.getNode('FunctionDefinition', endpoint.handlerFunctionId);
        if (handlerFunction) {
          const reachable = bfsCallGraph(store, handlerFunction.id, maxCallDepth);
          dbHops = findDatabaseHops(store, reachable);
          downstreamCalls = walkServiceHops(store, reachable, maxCallDepth, remainingHops - 1, nextVisited);
        }
      }

      hops.push({
        caller,
        endpoint,
        handlerFunction,
        repository: endpoint.repository,
        databaseHops: dbHops,
        downstreamCalls,
      });
    }
  }

  return hops;
}

/** Check if a ServiceHop (or any of its descendants) reaches a DB interaction. */
function hasDbInteraction(hop: ServiceHop): boolean {
  if (hop.databaseHops.length > 0) return true;
  return hop.downstreamCalls.some(hasDbInteraction);
}

// ──────────────────────────────────────────────────────────────────────
// Graph traversal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * BFS over the `CALLS_FUNCTION` edges starting from `rootFunctionId`.
 * Returns a `Set` of FunctionDefinition ids reachable within
 * `maxDepth` hops, including the root itself. Visited ids are tracked
 * to break cycles.
 */
function bfsCallGraph(
  store: CanonicalGraphStore,
  rootFunctionId: string,
  maxDepth: number
): Set<string> {
  const visited = new Set<string>([rootFunctionId]);
  let frontier: string[] = [rootFunctionId];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const fnId of frontier) {
      const edges = store.findEdges(fnId, null, 'CALLS_FUNCTION');
      for (const edge of edges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
    depth += 1;
  }
  return visited;
}

/**
 * Find every `ClientSideAPICaller` whose `functionId` is in the
 * given set of function ids. Uses the store's property filter to
 * query by `functionId` for each id in the set.
 */
function findCallersInFunctions(
  store: CanonicalGraphStore,
  functionIds: Set<string>
): ClientSideAPICaller[] {
  if (functionIds.size === 0) return [];
  const callers: ClientSideAPICaller[] = [];
  for (const fnId of functionIds) {
    const matches = store.findNodes('ClientSideAPICaller', { functionId: fnId } as Partial<ClientSideAPICaller>);
    callers.push(...matches);
  }
  return callers;
}

/**
 * Find every `DatabaseInteraction` whose `callSiteFunctionId` is in
 * the given set of function ids, and pair each with its reads/writes
 * table via the ORM detector's `READS` / `WRITES` edges. Uses the
 * store's property filter to query by `callSiteFunctionId`.
 */
function findDatabaseHops(
  store: CanonicalGraphStore,
  functionIds: Set<string>
): FlowDatabaseHop[] {
  if (functionIds.size === 0) return [];
  const hops: FlowDatabaseHop[] = [];
  for (const fnId of functionIds) {
    const interactions = store.findNodes('DatabaseInteraction', { callSiteFunctionId: fnId } as Partial<DatabaseInteraction>);
    for (const interaction of interactions) {
      const readsTables = findReadsTables(store, interaction);
      const writesTables = findWritesTables(store, interaction);

      hops.push({
        interaction,
        readsTables,
        writesTables,
        readsTable: readsTables[0] ?? null,
        writesTable: writesTables[0] ?? null,
      });
    }
  }
  return hops;
}

/**
 * Find all navigation targets reachable from the given function set (#167).
 * Looks for NAVIGATES_TO edges from any function in the set, resolves the
 * target Screen nodes, and follows SCREEN_COMPONENT edges to find the
 * component function.
 */
function findNavigationTargets(
  store: CanonicalGraphStore,
  functionIds: Set<string>
): FlowNavigationTarget[] {
  if (functionIds.size === 0) return [];
  // Collect all methods per screen to avoid losing info when multiple
  // functions navigate to the same screen via different methods.
  const targetMap = new Map<string, { screen: Screen; componentFunction: FunctionDefinition | null; methods: Set<string> }>();

  for (const fnId of functionIds) {
    const navEdges = store
      .findEdges(fnId, null, 'NAVIGATES_TO')
      .filter((e): e is NavigatesToEdge => e.edgeType === 'NAVIGATES_TO');

    for (const edge of navEdges) {
      const method = edge.method ?? 'navigate';
      const existing = targetMap.get(edge.to);
      if (existing) {
        existing.methods.add(method);
        continue;
      }

      const screen = store.getNode('Screen', edge.to) as Screen | null;
      if (!screen) continue;

      // Follow SCREEN_COMPONENT edge to find the component function
      let componentFunction: FunctionDefinition | null = null;
      if (screen.componentFunctionId) {
        componentFunction = store.getNode('FunctionDefinition', screen.componentFunctionId);
      }
      // Also try via SCREEN_COMPONENT edge if componentFunctionId is null
      if (!componentFunction) {
        const compEdges = store.findEdges(screen.id, null, 'SCREEN_COMPONENT');
        if (compEdges.length > 0) {
          componentFunction = store.getNode('FunctionDefinition', compEdges[0].to);
        }
      }

      targetMap.set(edge.to, { screen, componentFunction, methods: new Set([method]) });
    }
  }

  return [...targetMap.values()].map((t) => ({
    screen: t.screen,
    componentFunction: t.componentFunction,
    methods: [...t.methods],
  }));
}

/** Return all tables a `DatabaseInteraction` reads from. */
function findReadsTables(
  store: CanonicalGraphStore,
  interaction: DatabaseInteraction
): DatabaseTable[] {
  const edges = store
    .findEdges(interaction.id, null, 'READS')
    .filter((e): e is ReadsEdge => e.edgeType === 'READS');
  const tables: DatabaseTable[] = [];
  for (const edge of edges) {
    const table = store.getNode('DatabaseTable', edge.to);
    if (table) tables.push(table);
  }
  return tables;
}

/** Return all tables a `DatabaseInteraction` writes to. */
function findWritesTables(
  store: CanonicalGraphStore,
  interaction: DatabaseInteraction
): DatabaseTable[] {
  const edges = store
    .findEdges(interaction.id, null, 'WRITES')
    .filter((e): e is WritesEdge => e.edgeType === 'WRITES');
  const tables: DatabaseTable[] = [];
  for (const edge of edges) {
    const table = store.getNode('DatabaseTable', edge.to);
    if (table) tables.push(table);
  }
  return tables;
}

// ──────────────────────────────────────────────────────────────────────
// Flow builder
// ──────────────────────────────────────────────────────────────────────

interface BuildFlowArgs {
  process: ClientSideProcess;
  startFunction?: FunctionDefinition;
  caller?: ClientSideAPICaller;
  endpoint?: APIEndpoint;
  handlerFunction?: FunctionDefinition;
  matchConfidence?: Flow['matchConfidence'];
  matchedBy?: Flow['matchedBy'];
  databaseHops?: FlowDatabaseHop[];
  serviceHops?: ServiceHop[];
  navigationTargets?: FlowNavigationTarget[];
  completeness: FlowCompleteness;
}

function buildFlow(args: BuildFlowArgs): Flow {
  // Extract response data from the handler and caller nodes.
  const responses = args.handlerFunction?.responses ?? [];
  const responseHandlers = args.caller?.responseHandlers ?? [];

  return {
    startProcess: args.process,
    startFunction: args.startFunction ?? null,
    caller: args.caller ?? null,
    endpoint: args.endpoint ?? null,
    matchConfidence: args.matchConfidence ?? null,
    matchedBy: args.matchedBy ?? null,
    handlerFunction: args.handlerFunction ?? null,
    databaseHops: args.databaseHops ?? [],
    serviceHops: args.serviceHops ?? [],
    navigationTargets: args.navigationTargets ?? [],
    responses,
    responseHandlers,
    completeness: args.completeness,
  };
}
