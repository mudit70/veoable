import type {
  APIEndpoint,
  ClientSideAPICaller,
  ClientSideProcess,
  DatabaseInteraction,
  DatabaseTable,
  FunctionDefinition,
  MatchConfidence,
  ResolvesMatchedBy,
  ResponseHandler,
  ResponseShape,
  Screen,
} from '@adorable/schema';

/**
 * How far a flow walk was able to get through the canonical graph
 * before running out of edges to follow. Used so the UI can show
 * incomplete flows without filtering them out entirely.
 */
export type FlowCompleteness =
  /** Process node found, but its enclosing function isn't in the store. */
  | 'process-only'
  /** Process + enclosing function reached, but no `ClientSideAPICaller` in scope. */
  | 'function-only'
  /** Caller reached, but no `RESOLVES_TO_ENDPOINT` edge found (dynamic URL or no match). */
  | 'caller-only'
  /** Endpoint reached, but its `handlerFunctionId` is null or unresolved. */
  | 'endpoint-only'
  /** Handler function reached, but no `DatabaseInteraction` reachable from it. */
  | 'handler-only'
  /** Full chain: process → caller → endpoint → handler → at least one DB interaction.
   *  With multi-hop (#137), the DB interaction may be in serviceHops rather than
   *  databaseHops — check both when filtering by table. */
  | 'complete';

/**
 * A single end-to-end path through the canonical graph, from a
 * `ClientSideProcess` down to the database tables it ultimately
 * reaches. A process that triggers two different client API callers
 * produces two flows. A caller that could resolve to two ambiguous
 * endpoints also produces two flows (one per endpoint hop).
 *
 * The walker emits one `Flow` per concrete path. The UI is expected
 * to group flows by `startProcess.id` when presenting them.
 */
export interface Flow {
  /** The `ClientSideProcess` node this flow starts from. */
  startProcess: ClientSideProcess;

  /** The FunctionDefinition that contains the process trigger. */
  startFunction: FunctionDefinition | null;

  /**
   * The `ClientSideAPICaller` the process (or its transitive call
   * graph) invokes. Present for flows at `caller-only` or deeper.
   */
  caller: ClientSideAPICaller | null;

  /**
   * The `APIEndpoint` that `caller.urlLiteral` resolves to, per the
   * `RESOLVES_TO_ENDPOINT` edge the stitcher emitted in PR 1. Present
   * for flows at `endpoint-only` or deeper.
   */
  endpoint: APIEndpoint | null;

  /**
   * The confidence with which `caller` was matched to `endpoint`.
   * Copied from the `RESOLVES_TO_ENDPOINT` edge.
   */
  matchConfidence: MatchConfidence | null;

  /**
   * How the `caller` ↔ `endpoint` match was resolved. Copied from the
   * `RESOLVES_TO_ENDPOINT` edge.
   */
  matchedBy: ResolvesMatchedBy | null;

  /**
   * The server-side handler function the endpoint points at, via
   * `APIEndpoint.handlerFunctionId`. Present for flows at
   * `handler-only` or deeper.
   */
  handlerFunction: FunctionDefinition | null;

  /**
   * Every `DatabaseInteraction` reachable from `handlerFunction` via
   * the transitive `CALLS_FUNCTION` call graph, paired with the
   * table(s) the interaction reads or writes. Present for flows at
   * `complete` only.
   */
  databaseHops: FlowDatabaseHop[];

  // ── Response path (#108) ──────────────────────────────────────────

  /**
   * HTTP response shapes the handler can produce (status codes, body
   * expressions, error paths). Extracted from `res.json()` / `res.status()`
   * patterns in the handler function.
   */
  responses: ResponseShape[];

  /**
   * Client-side response handling chain — how the fetch response is
   * processed (JSON parse, state update, error handling). Extracted
   * from `.then()` / `.catch()` chains after the fetch call.
   */
  responseHandlers: ResponseHandler[];

  /**
   * Downstream service calls made by the handler (#137). Present when
   * the handler makes outbound API calls that resolve to endpoints in
   * other services. Each hop may itself have downstream hops (recursive).
   */
  serviceHops: ServiceHop[];

  /**
   * Navigation targets reachable from the process's call graph (#167).
   * Present when the process's reachable functions contain
   * `navigation.navigate('X')` calls that map to Screen nodes via
   * NAVIGATES_TO edges.
   */
  navigationTargets: FlowNavigationTarget[];

  /** Completeness summary — see `FlowCompleteness`. */
  completeness: FlowCompleteness;
}

/**
 * One hop in a multi-service chain (#137). Represents the handler of
 * one service calling an endpoint in another service, recursively.
 */
export interface ServiceHop {
  /** The outbound API call from the upstream handler. */
  caller: ClientSideAPICaller;
  /** The downstream endpoint it resolves to. */
  endpoint: APIEndpoint;
  /** The downstream handler function. */
  handlerFunction: FunctionDefinition | null;
  /** Repository/service name of the downstream service. */
  repository: string;
  /** Database interactions reachable from the downstream handler. */
  databaseHops: FlowDatabaseHop[];
  /** Further downstream calls (recursive). */
  downstreamCalls: ServiceHop[];
}

/**
 * A navigation target reachable from a flow's call graph (#167).
 * Represents a `navigation.navigate('X')` call that resolves to a
 * Screen node, optionally with the screen's component function.
 */
export interface FlowNavigationTarget {
  /** The Screen node being navigated to. */
  screen: Screen;
  /** The component function rendered by the screen (via SCREEN_COMPONENT edge). */
  componentFunction: FunctionDefinition | null;
  /** The navigation methods used to reach this screen (e.g., ['navigate', 'push']). */
  methods: string[];
}

/**
 * One database interaction reached by a flow, along with the table(s)
 * it touches via the `READS` / `WRITES` edges the ORM detector emitted.
 * An interaction with an `operation: 'raw'` typically has no resolved
 * table; both sides may be null in that case.
 */
export interface FlowDatabaseHop {
  interaction: DatabaseInteraction;
  /** Tables the interaction reads from. */
  readsTables: DatabaseTable[];
  /** Tables the interaction writes to. */
  writesTables: DatabaseTable[];
  /**
   * @deprecated Use `readsTables[0]` instead. Kept for backwards
   * compatibility with formatFlows consumers.
   */
  readsTable: DatabaseTable | null;
  /**
   * @deprecated Use `writesTables[0]` instead. Kept for backwards
   * compatibility with formatFlows consumers.
   */
  writesTable: DatabaseTable | null;
}
