import type { MatchConfidence, ResolvesMatchedBy } from '@veoable/schema';
import type { ProxyRule } from './proxy-config.js';

/**
 * URL matching for the flow stitcher.
 *
 * Given a `ClientSideAPICaller`'s static URL information and a set of
 * `APIEndpoint`s with route patterns, determine which endpoint(s) the
 * caller is talking to and with what confidence. The matcher is a
 * **pure function** — it does not touch the graph store, record span
 * events, or produce `NodeBatch`es. That belongs to the thin
 * `stitcher.ts` wrapper.
 *
 * Route pattern segments:
 *   - literal   → `users`
 *   - param     → `:id`
 *   - optional  → `:id?`  (Express 5)
 *   - splat     → `*`
 *
 * Caller URL shapes:
 *   - full literal       → `/api/users/123` (from `StringLiteral`)
 *   - template prefix    → `/api/users/`    (from `TemplateExpression` head;
 *                          the remainder is dynamic)
 *   - dynamic (null url) → not matched here — deferred to PR 3
 *
 * Confidence levels:
 *   - `high`  + `exact-url`  — caller url is a complete literal and
 *                              every pattern segment is a literal
 *                              with an exact match
 *   - `high`  + `pattern`    — caller url is a complete literal that
 *                              matches a param-bearing route; every
 *                              literal segment lines up and every
 *                              param segment consumes exactly one
 *                              caller segment
 *   - `medium` + `pattern`   — caller url is a template prefix that
 *                              matches the static-prefix portion of
 *                              the pattern; the dynamic tail of the
 *                              template fills the remaining pattern
 *                              segments
 *   - `low`    + `inferred`  — fuzzy prefix match, multiple endpoints
 *                              could match the same caller; the
 *                              stitcher emits one edge per candidate
 */

export type HttpMethodInput = string | null;

export interface MatcherCaller {
  /** Stable caller id (the `ClientSideAPICaller.id`). */
  id: string;
  /** Uppercased HTTP method, or null if the caller's method is dynamic. */
  httpMethod: HttpMethodInput;
  /**
   * Static URL literal — either the full path (from a StringLiteral)
   * or the static head of a template expression. `null` when the
   * caller's URL is fully dynamic; such callers are deferred to PR 3.
   */
  urlLiteral: string | null;
  /**
   * Egress confidence from the caller's own detection. Used to tell
   * full literals (`'exact'`) apart from template prefixes
   * (`'pattern'`).
   */
  egressConfidence: 'exact' | 'pattern' | 'dynamic';
  /**
   * Number of template literal interpolation spans (e.g.,
   * `` `/api/users/${id}` `` has 1 span). Used for segment-count
   * matching: a template with N spans produces N dynamic segments,
   * so the total URL segment count is deterministic.
   * `null` for exact callers and dynamic callers.
   */
  templateSpanCount?: number | null;
  /**
   * Total number of URL segments computed from the full template
   * structure, including literal text between and after spans.
   * More accurate than `prefix segments + spanCount` because it
   * accounts for suffixes like `/posts` after an interpolation.
   * `null` for exact callers and dynamic callers.
   */
  templateSegmentCount?: number | null;
  /**
   * All literal parts of a template URL, including suffixes between/after
   * spans. e.g., `/projects/${id}/diagrams` → ['/projects/', '/diagrams'].
   * When present, enables exact pattern reconstruction for disambiguation.
   */
  templateParts?: string[] | null;
}

export interface MatcherEndpoint {
  /** Stable endpoint id (the `APIEndpoint.id`). */
  id: string;
  /** Uppercased HTTP method. */
  httpMethod: string;
  /** Route pattern as declared (e.g. `/api/users/:id`). */
  routePattern: string;
}

export interface MatchResult {
  endpointId: string;
  matchConfidence: MatchConfidence;
  matchedBy: ResolvesMatchedBy;
  /**
   * Internal ranking tier used by the stitcher for ambiguity
   * resolution. Distinguishes `exact-url` from `pattern` at the
   * same `MatchConfidence` so the stitcher can pick the exact
   * winner instead of downgrading to `low + inferred`.
   *
   * Higher is better. The `MatchConfidence` value stays at three
   * levels (`high | medium | low`); `matchRank` is the tiebreak
   * key and is not persisted to the canonical schema.
   *
   * Current tiers:
   *   - 5: full-literal caller + exact-url pattern (no params at all)
   *   - 4: full-literal caller + pattern with params
   *   - 2: template-prefix caller + pattern with remaining param(s)
   *        that the template's dynamic tail can fill
   *   - 1: reserved for future template-prefix refinements
   */
  matchRank: number;
}

/**
 * Match one caller against every endpoint. Returns the subset that
 * matched, each with its confidence. If multiple endpoints match at
 * the same highest confidence, all of them are returned (the caller
 * decides whether to treat that as ambiguous).
 *
 * `proxyRules` (#188 Cause 2): when supplied, the matcher tries each
 * applicable rule's variant of the caller URL before giving up. A
 * frontend `fetch('/api/users/:id')` whose dev server proxies `/api`
 * → backend with `rewrite: (p) => p.replace(/^\/api/, '')` matches
 * the backend's `/users/:id` route under this branch.
 *
 * Behavior:
 *   - First tries the original URL (no transformation). If that
 *     resolves, it wins.
 *   - For each rule whose `prefix` matches the caller URL: if
 *     `stripsPrefix`, generate a variant with the prefix stripped;
 *     otherwise leave the variant unchanged (no-op rule). Try
 *     matching that variant.
 *   - First rule that produces a match wins. The match's
 *     `matchedBy` is unchanged so downstream consumers can't tell
 *     proxy-bridged matches from direct ones — the rule is a build
 *     concern, not a confidence indicator.
 */
export function matchCallerToEndpoints(
  caller: MatcherCaller,
  endpoints: readonly MatcherEndpoint[],
  proxyRules?: readonly ProxyRule[]
): MatchResult[] {
  if (caller.urlLiteral === null) return [];
  if (caller.egressConfidence === 'dynamic') return [];

  // Try the original URL first.
  const direct = matchCallerCore(caller, endpoints);
  if (direct.length > 0) return direct;

  // Try each applicable proxy rule's variant. Skip rules whose
  // prefix doesn't apply to this caller's URL.
  if (proxyRules && proxyRules.length > 0) {
    for (const rule of proxyRules) {
      if (!rule.stripsPrefix) continue; // no-op rules add nothing
      const transformed = applyProxyRuleToUrl(caller.urlLiteral, rule);
      if (transformed === null) continue;
      const variant: MatcherCaller = {
        ...caller,
        urlLiteral: transformed,
        templateParts: applyProxyRuleToParts(caller.templateParts, rule),
      };
      const matches = matchCallerCore(variant, endpoints);
      if (matches.length > 0) return matches;
    }
  }

  return [];
}

/**
 * Test whether a URL is prefixed by a proxy rule with proper segment
 * boundary semantics: `/api` matches `/api`, `/api/users`, and
 * `/api?...`, but NOT `/apidocs` (where the prefix would land
 * mid-segment).
 *
 * Also skips external URLs — a proxy rule should never strip a path
 * prefix from `https://api.github.com/...`. The dev-server proxy
 * only intercepts same-origin paths.
 */
function isProxyPrefixMatch(url: string, prefix: string): boolean {
  // External URLs are routed by their host, not local proxy.
  if (/^https?:\/\//i.test(url)) return false;
  if (!url.startsWith(prefix)) return false;
  // Boundary check: end of string, slash, or query separator.
  const next = url.charAt(prefix.length);
  return next === '' || next === '/' || next === '?';
}

/**
 * Strip a proxy rule's prefix from a URL when it applies. Returns
 * the transformed URL or null if the rule doesn't apply.
 */
function applyProxyRuleToUrl(url: string, rule: ProxyRule): string | null {
  if (!isProxyPrefixMatch(url, rule.prefix)) return null;
  const stripped = url.slice(rule.prefix.length);
  // Ensure the result still starts with '/' so segment splitting
  // produces the same shape downstream.
  if (stripped === '') return '/';
  return stripped.startsWith('/') ? stripped : '/' + stripped;
}

/**
 * Apply a proxy rule to a `templateParts` array. The first part is
 * where the prefix lives; subsequent parts are after placeholders.
 * If the rule's prefix matches the start of the first part with a
 * proper segment boundary, strip it. Otherwise return the array
 * unchanged.
 */
function applyProxyRuleToParts(
  parts: readonly string[] | null | undefined,
  rule: ProxyRule
): string[] | null {
  if (!parts || parts.length === 0) return null;
  const head = parts[0];
  // Same boundary semantics as applyProxyRuleToUrl.
  if (!isProxyPrefixMatch(head, rule.prefix)) return parts.slice() as string[];
  const stripped = head.slice(rule.prefix.length);
  const newHead = stripped === '' ? '/' : (stripped.startsWith('/') ? stripped : '/' + stripped);
  return [newHead, ...parts.slice(1)];
}

/**
 * Core matching logic — runs the original (non-proxy) match path
 * unchanged. Pulled out so the public function can run it twice
 * (once on the original URL, once on each proxy-rule-rewritten
 * variant).
 */
function matchCallerCore(
  caller: MatcherCaller,
  endpoints: readonly MatcherEndpoint[]
): MatchResult[] {

  // Fast path: when templateParts are available, reconstruct a full
  // URL pattern by joining literal parts with `:param` placeholders.
  // This enables exact matching even for template URLs.
  // e.g., ['/projects/', '/diagrams'] → '/projects/:p0/diagrams'
  if (caller.templateParts && caller.templateParts.length > 1) {
    // Match-time query stripping: visitor-side templateParts now
    // preserve query strings (#188 PR A: `${url}?r=${name}` shapes
    // need them in `urlLiteral`). Endpoint route patterns never
    // include queries, so strip before segment comparison.
    const rawReconstructed = caller.templateParts
      .map((part, i) => i < caller.templateParts!.length - 1 ? part + `:p${i}` : part)
      .join('');
    const queryAt = rawReconstructed.indexOf('?');
    const pathOnly = queryAt < 0 ? rawReconstructed : rawReconstructed.slice(0, queryAt);
    // Strip a leading `:p<n>/` placeholder when it represents an
    // implicit base-URL prefix (the template literal started with
    // `${BASE}/…`). See stripLeadingBasePlaceholder.
    const basePrefixStripped = stripLeadingBasePlaceholder(pathOnly);
    const reconstructed = basePrefixStripped.replace(/\/+$/, ''); // strip trailing slash

    // Edge case: a caller URL of just `${BASE}/` (no path after the
    // base-URL placeholder) reduces to "" once split on `/`. That
    // becomes a 1-segment array containing an empty string, which
    // could spuriously fill a single-param endpoint (e.g. `GET /:foo`).
    // Skip the fast path so it never produces a match — the slow
    // path's `parseCallerUrl` returns `segments: []` for this input
    // and naturally bails. Tracked via #526.
    if (reconstructed !== '') {

    const methodFilter = caller.httpMethod;
    const candidates = methodFilter !== null
      ? endpoints.filter((e) => e.httpMethod === methodFilter)
      : endpoints;

    // Try exact match of the reconstructed URL against each endpoint.
    for (const ep of candidates) {
      const epNorm = ep.routePattern.replace(/\/+$/, '');
      const recSegments = reconstructed.replace(/^\/+/, '').split('/');
      const epSegments = epNorm.replace(/^\/+/, '').split('/');

      if (recSegments.length !== epSegments.length) continue;

      let matches = true;
      for (let i = 0; i < recSegments.length; i++) {
        const rs = recSegments[i];
        const es = epSegments[i];
        // Both are params → match
        if (rs.startsWith(':') && es.startsWith(':')) continue;
        // One is a param → match (caller param fills endpoint param or vice versa)
        if (rs.startsWith(':') || es.startsWith(':')) continue;
        // Both are literals → must be equal
        if (rs !== es) { matches = false; break; }
      }

      if (matches) {
        return [{
          endpointId: ep.id,
          matchConfidence: 'high',
          matchedBy: 'pattern',
          matchRank: 4, // Same rank as full-literal + pattern
        }];
      }
    }
    } // close `if (reconstructed !== '')`
    // Fall through to normal matching if no exact reconstruction match.
  }

  // Method mismatch is a hard filter when the caller's method is
  // known. When the caller's method is null (the fetch plugin
  // classifies shorthand / identifier methods that way), we fall
  // through and match by URL only — the stitcher can still produce
  // a low-confidence edge.
  const methodFilter = caller.httpMethod;
  const candidates =
    methodFilter !== null
      ? endpoints.filter((e) => e.httpMethod === methodFilter)
      : endpoints;

  const results: MatchResult[] = [];
  for (const endpoint of candidates) {
    const match = matchOne(caller, endpoint);
    if (match) results.push({ endpointId: endpoint.id, ...match });
  }

  // Sort results descending by internal matchRank so that callers
  // can rely on `results[0]` being the strongest match. Ties
  // preserve their original iteration order (stable sort), so two
  // endpoints tied at the same rank come out in endpoint-list order.
  // matchRank is strictly finer-grained than MatchConfidence so
  // that `exact-url` sorts strictly above `pattern` at the same
  // `high` confidence level.
  results.sort((a, b) => b.matchRank - a.matchRank);

  return results;
}

/**
 * Numeric rank of a {@link MatchConfidence} value: `high` > `medium` > `low`.
 * Exported so the stitcher can reuse the same ordering.
 */
export function confidenceRank(c: MatchConfidence): number {
  switch (c) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-endpoint matching
// ──────────────────────────────────────────────────────────────────────

interface MatchShape {
  matchConfidence: MatchConfidence;
  matchedBy: ResolvesMatchedBy;
  matchRank: number;
}

function matchOne(caller: MatcherCaller, endpoint: MatcherEndpoint): MatchShape | null {
  const patternSegments = parsePattern(endpoint.routePattern);
  const callerUrl = stripLeadingBasePlaceholder(caller.urlLiteral!);
  const { segments: callerSegments, trailing } = parseCallerUrl(callerUrl);

  // If the caller url ended on a `/` (template prefix like
  // `/api/users/`), the caller's segments are `['api', 'users']` and
  // `trailing` is `true`. Otherwise the caller is a full literal
  // path and `trailing` is `false`.
  const callerIsFullLiteral = caller.egressConfidence === 'exact' && !trailing;

  // ── Walk segments in lockstep ────────────────────────────────────
  let ci = 0;
  let pi = 0;
  let anyParamConsumed = false;
  let splatMatched = false;
  let optionalParamSkipped = false;

  while (pi < patternSegments.length) {
    const patternSeg = patternSegments[pi];

    // Splat eats the rest of the caller URL.
    if (patternSeg.kind === 'splat') {
      splatMatched = true;
      ci = callerSegments.length;
      pi += 1;
      break;
    }

    // Optional param can be skipped if we're out of caller segments.
    if (patternSeg.kind === 'optional-param' && ci >= callerSegments.length) {
      optionalParamSkipped = true;
      pi += 1;
      continue;
    }

    // Ran out of caller segments for a required pattern segment.
    if (ci >= callerSegments.length) {
      // Template prefix that stops before the pattern finishes —
      // still a pattern match if the literal segments we saw all
      // lined up.
      if (trailing) break;
      return null;
    }

    const callerSeg = callerSegments[ci];

    if (patternSeg.kind === 'literal') {
      if (patternSeg.value !== callerSeg) return null;
    } else {
      // #268 — param / optional-param: must consume a NON-EMPTY caller
      // segment to be a valid runtime URL. An empty segment between
      // slashes (e.g., `songs//report` from `SONG_DETAIL + '/' + REPORT`
      // where SONG_DETAIL already trails a slash) is not a legal value
      // for a path parameter — the request 404s at runtime. Reject so
      // string-concatenation URL bugs surface as unmatched, not as
      // high-confidence pattern stitches.
      if (callerSeg === '') return null;
      anyParamConsumed = true;
    }

    ci += 1;
    pi += 1;
  }

  // ── Tail checks ──────────────────────────────────────────────────
  const allPatternsConsumed = pi >= patternSegments.length;
  const allCallerConsumed = ci >= callerSegments.length;

  // Full literal caller: every caller segment AND every pattern
  // segment must be consumed (unless a splat ate the rest or all
  // remaining pattern segments are optional).
  if (callerIsFullLiteral) {
    if (!allCallerConsumed) return null;
    if (!allPatternsConsumed) {
      // If what's left is all optional-params, still a match.
      for (let i = pi; i < patternSegments.length; i++) {
        if (patternSegments[i].kind !== 'optional-param') return null;
      }
    }
    // Confidence: exact-url if no params were consumed AND no splat,
    // otherwise pattern. Internal matchRank strictly separates the
    // two so the stitcher can pick exact-url as the clear winner
    // when both an exact route and a param route would match.
    if (!anyParamConsumed && !splatMatched) {
      return { matchConfidence: 'high', matchedBy: 'exact-url', matchRank: 5 };
    }
    return { matchConfidence: 'high', matchedBy: 'pattern', matchRank: 4 };
  }

  // Template-prefix caller (trailing `/`) whose walk completed the
  // WHOLE pattern means the caller has a dynamic tail past the
  // pattern's end. That's a contradiction: the template promises at
  // least one more runtime segment, but the pattern has no room for
  // it. Reject.
  //
  // Example: caller `/api/users/` template-prefix vs pattern
  // `/api/users`. Both sides walked fully (`pi=2, ci=2`), so the
  // runtime URL like `/api/users/42` has more segments than the
  // pattern can accept. This used to return medium+pattern, which
  // was wrong — the correct intended target for the caller is a
  // longer pattern like `/api/users/:id`.
  // Splat and trailing-optional-param are exceptions: both represent
  // pattern room the template's dynamic tail can legitimately fill.
  if (
    trailing &&
    allPatternsConsumed &&
    allCallerConsumed &&
    !splatMatched &&
    !optionalParamSkipped
  ) {
    return null;
  }

  // Template-prefix caller whose head ends in `/` and whose walk
  // broke out mid-pattern on a required segment — every caller
  // segment lined up with a literal/param pattern segment before
  // the walk ran out of caller. The template's dynamic tail can
  // fill any remaining pattern segments, so we accept at medium.
  //
  // Segment-count refinement: if the caller has a known
  // templateSpanCount, we can compute the exact total number of
  // URL segments and reject patterns that don't match.
  if (trailing) {
    // Segment-count matching: use templateSegmentCount (which accounts
    // for literal text between/after spans) for an exact segment count
    // comparison. Falls back to templateSpanCount if available.
    const expectedTotalSegments = caller.templateSegmentCount
      ?? (caller.templateSpanCount != null && caller.templateSpanCount > 0
        ? callerSegments.length + caller.templateSpanCount
        : null);

    if (expectedTotalSegments != null) {
      const patternTotalSegments = patternSegments.length;

      if (patternTotalSegments !== expectedTotalSegments) {
        return null; // Segment count mismatch — reject.
      }

      // Segment count matches — this is a deterministic match.
      return { matchConfidence: 'high', matchedBy: 'pattern', matchRank: 4 };
    }

    return { matchConfidence: 'medium', matchedBy: 'pattern', matchRank: 2 };
  }

  // Template-prefix caller whose head does NOT end in `/`
  // (e.g. head of `` `/api/users${suffix}` ``). The last caller
  // segment is a *partial* literal that the dynamic tail will
  // extend. We can only safely claim a match when the walk
  // consumed the entire route pattern and every caller segment
  // lined up — i.e. the template head by itself already hits the
  // endpoint. We still rank it medium because the dynamic tail
  // could keep going past the endpoint.
  if (allPatternsConsumed && allCallerConsumed) {
    return { matchConfidence: 'medium', matchedBy: 'pattern', matchRank: 2 };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────

type PatternSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'optional-param'; name: string }
  | { kind: 'splat' };

function parsePattern(pattern: string): PatternSegment[] {
  const trimmed = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return [];
  return trimmed.split('/').map((raw): PatternSegment => {
    if (raw === '*') return { kind: 'splat' };
    if (raw.startsWith(':')) {
      const nameRaw = raw.slice(1);
      if (nameRaw.endsWith('?')) {
        return { kind: 'optional-param', name: nameRaw.slice(0, -1) };
      }
      return { kind: 'param', name: nameRaw };
    }
    return { kind: 'literal', value: raw };
  });
}

interface CallerUrlParts {
  segments: string[];
  trailing: boolean;
}

/**
 * Strip a leading `:p<n>` placeholder when it represents a base-URL prefix.
 *
 *   ':p0/api/tasks'      → '/api/tasks'
 *   ':p0api/tasks'       → ':p0api/tasks'   (no separating slash — keep)
 *   ':p0/api/users/:p1'  → '/api/users/:p1'
 *   '/api/users/:p0'     → '/api/users/:p0' (placeholder mid-pattern)
 *
 * Rationale: TS frontends commonly write `fetch(\`${BASE}/api/tasks\`)`
 * where BASE is an empty string default or the API origin. The resolver
 * lifts `${BASE}` into a `:p0` placeholder. The stitcher then sees a
 * 3-segment caller against a 2-segment endpoint pattern and bails out.
 * Treating a leading `:p<n>/` as an implicit base URL recovers the match.
 */
export function stripLeadingBasePlaceholder(url: string): string {
  // Only strip when the placeholder appears at the very start AND is
  // followed by `/` (so we never eat part of a real segment).
  const m = /^(?::p\d+)\/(.*)$/.exec(url);
  return m ? '/' + m[1] : url;
}

function parseCallerUrl(url: string): CallerUrlParts {
  // Match-time query stripping: visitor-side urlLiterals can carry
  // query strings (#188 PR A). Endpoint route patterns never include
  // queries — strip before segment splitting so `/api/users?expand=foo`
  // matches `/api/users`.
  const queryAt = url.indexOf('?');
  const pathOnly = queryAt < 0 ? url : url.slice(0, queryAt);
  // Strip leading slashes; remember trailing slash so we can
  // distinguish `/users` from `/users/` (the template-prefix case).
  const leadingStripped = pathOnly.replace(/^\/+/, '');
  const trailing = leadingStripped.endsWith('/');
  const body = leadingStripped.replace(/\/+$/, '');
  const segments = body === '' ? [] : body.split('/');
  return { segments, trailing };
}
