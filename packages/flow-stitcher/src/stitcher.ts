import type {
  APIEndpoint,
  ClientSideAPICaller,
  ResolvesToEndpointEdge,
  SchemaEdge,
} from '@veoable/schema';
import type { NodeBatch } from '@veoable/plugin-api';
import { recordConfidenceDecision } from '@veoable/observability';
import type { CanonicalGraphStore } from '@veoable/graph-db';
import {
  matchCallerToEndpoints,
  type MatcherCaller,
  type MatcherEndpoint,
} from './url-matcher.js';
import type { ProxyRule } from './proxy-config.js';
import { ALLOW_ANY_APPLICATION_PAIR, type ApplicationScope } from './application-scope.js';

/**
 * Flow stitcher — deterministic URL matching layer (#4 PR 1/2).
 *
 * Reads `ClientSideAPICaller` and `APIEndpoint` nodes from a canonical
 * store (or takes them as arguments, for pure / test use) and emits
 * `RESOLVES_TO_ENDPOINT` edges connecting callers to the endpoints
 * their URLs resolve to, per the match confidence levels from the
 * URL matcher.
 *
 * The stitcher does NOT:
 *   - Walk `CALLS_FUNCTION` chains (that's the flow-walker in PR 2)
 *   - Attempt AI-assisted matching for dynamic callers (PR 3)
 *   - Persist its output directly — the orchestrator commits the
 *     returned `NodeBatch` to the store
 *
 * Every emitted edge is typed `RESOLVES_TO_ENDPOINT` with `matchedBy`
 * and `matchConfidence` fields populated by the matcher. Every
 * `medium` / `low` / skipped-dynamic decision records a
 * `ConfidenceDecision` span event via `@veoable/observability` so
 * the stitching rationale is visible in the trace.
 */

export const FLOW_STITCHER_PRODUCER_ID = 'flow-stitcher' as const;

export interface StitchOptions {
  /**
   * Build-tool proxy rules (#188 Cause 2). When supplied, the matcher
   * will retry each caller URL with applicable rules' transformations
   * (e.g., strip `/api` when the dev server proxies it). Rules are
   * usually discovered per-repo via `discoverProxyRules(repoRoot)` in
   * `proxy-config.ts`.
   */
  proxyRules?: readonly ProxyRule[];

  /**
   * Application-pair scope (#255). When supplied, restricts each
   * caller's matchable endpoints to those whose `repository` shares
   * an application with the caller's `repository`. Default behavior
   * (no scope or `ALLOW_ANY_APPLICATION_PAIR`) preserves v1 cross-repo
   * stitching for projects without an `applications` declaration.
   */
  applicationScope?: ApplicationScope;
}

/**
 * Pure stitching: given a list of callers and endpoints, return a
 * `NodeBatch` containing only `RESOLVES_TO_ENDPOINT` edges. No nodes
 * are emitted. The orchestrator (or tests) commit the batch to the
 * canonical store to materialize the edges.
 */
export function stitchResolves(
  callers: readonly ClientSideAPICaller[],
  endpoints: readonly APIEndpoint[],
  options: StitchOptions = {}
): NodeBatch {
  const matcherEndpoints: MatcherEndpoint[] = endpoints.map((e) => ({
    id: e.id,
    httpMethod: e.httpMethod,
    routePattern: e.routePattern,
  }));

  // #255 — pre-build per-endpoint repository lookup for the
  // application-scope filter so we don't pay an N×M lookup cost.
  const endpointRepoById = new Map<string, string>();
  for (const e of endpoints) {
    endpointRepoById.set(e.id, e.repository);
  }
  const applicationScope = options.applicationScope ?? ALLOW_ANY_APPLICATION_PAIR;

  const edges: SchemaEdge[] = [];

  for (const caller of callers) {
    // Dynamic callers (null urlLiteral or explicit 'dynamic' egress
    // confidence) are deferred to PR 3. Record the decision so it's
    // visible in the trace and skip.
    if (caller.urlLiteral === null || caller.egressConfidence === 'dynamic') {
      recordConfidenceDecision('flow stitcher: caller url is dynamic, deferred to AI resolution', {
        'caller.id': caller.id,
        'caller.egressConfidence': caller.egressConfidence,
        'caller.httpMethod': caller.httpMethod ?? '<null>',
      });
      continue;
    }

    const matcherCaller: MatcherCaller = {
      id: caller.id,
      httpMethod: caller.httpMethod,
      urlLiteral: caller.urlLiteral,
      egressConfidence: caller.egressConfidence,
      templateSpanCount: caller.templateSpanCount ?? null,
      templateSegmentCount: caller.templateSegmentCount ?? null,
      templateParts: caller.templateParts ?? null,
    };

    // #255 — narrow the matcher's endpoint candidate set to those
    // whose repository is allowed by the application scope. With no
    // scope configured, this is a no-op (every endpoint passes).
    let filteredByScope = 0;
    const scopedEndpoints = matcherEndpoints.filter((me) => {
      const repo = endpointRepoById.get(me.id);
      if (repo === undefined) return true;
      const allowed = applicationScope(caller.repository, repo);
      if (!allowed) filteredByScope++;
      return allowed;
    });
    // Surface the filter so users debugging "why didn't this stitch?"
    // can see scope as the cause via stitch_report.
    if (filteredByScope > 0) {
      recordConfidenceDecision('flow stitcher: candidate(s) filtered by application-scope', {
        'caller.id': caller.id,
        'caller.repository': caller.repository,
        'scope.filtered': filteredByScope,
      });
    }

    const matches = matchCallerToEndpoints(matcherCaller, scopedEndpoints, options.proxyRules);

    if (matches.length === 0) {
      recordConfidenceDecision('flow stitcher: no matching endpoint', {
        'caller.id': caller.id,
        'caller.urlLiteral': caller.urlLiteral,
        'caller.httpMethod': caller.httpMethod ?? '<null>',
      });
      continue;
    }

    // Multiple matches at the same highest INTERNAL rank → emit
    // edges for each, downgrading everything to `low` + `inferred`
    // so the graph reader can tell the match was ambiguous.
    // Single-best match → emit the one edge with the matcher's own
    // confidence.
    //
    // Ambiguity is resolved on `matchRank` (the internal tier used
    // only for tiebreak), NOT on `matchConfidence` (the three-level
    // schema enum). This matters because `exact-url` and `pattern`
    // both map to `MatchConfidence: 'high'` but `exact-url` has a
    // strictly higher matchRank. A caller matching both `/api/users/me`
    // (exact) and `/api/users/:id` (param) at `high` should produce
    // exactly one edge — the exact one — not be flagged as ambiguous.
    const topRank = matches.reduce((acc, m) => Math.max(acc, m.matchRank), 0);
    const topMatches = matches.filter((m) => m.matchRank === topRank);
    const ambiguous = topMatches.length > 1;

    for (const m of topMatches) {
      if (ambiguous) {
        recordConfidenceDecision('flow stitcher: ambiguous match, multiple endpoints at same confidence', {
          'caller.id': caller.id,
          'endpoint.id': m.endpointId,
          'match.count': topMatches.length,
        });
      } else if (m.matchConfidence !== 'high') {
        recordConfidenceDecision('flow stitcher: non-exact URL match', {
          'caller.id': caller.id,
          'endpoint.id': m.endpointId,
          'match.confidence': m.matchConfidence,
          'match.matchedBy': m.matchedBy,
        });
      }

      const edge: ResolvesToEndpointEdge = {
        edgeType: 'RESOLVES_TO_ENDPOINT',
        from: caller.id,
        to: m.endpointId,
        matchedBy: ambiguous ? 'inferred' : m.matchedBy,
        matchConfidence: ambiguous ? 'low' : m.matchConfidence,
      };
      edges.push(edge);
    }
  }

  return { nodes: [], edges };
}

/**
 * Convenience wrapper: read every `ClientSideAPICaller` and
 * `APIEndpoint` from a canonical store, run `stitchResolves`, and
 * return the resulting batch. The caller is responsible for
 * committing the batch back to the store.
 */
export function stitchStore(store: CanonicalGraphStore, options: StitchOptions = {}): NodeBatch {
  const callers = store.findNodes('ClientSideAPICaller');
  const endpoints = store.findNodes('APIEndpoint');
  return stitchResolves(callers, endpoints, options);
}
