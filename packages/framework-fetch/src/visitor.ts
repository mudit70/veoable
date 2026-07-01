import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type Expression,
  type Identifier,
  type ObjectLiteralExpression,
} from 'ts-morph';
import {
  idFor,
  type ClientSideAPICaller,
  type HttpEgressConfidence,
  type ResponseHandler,
  type SourceEvidence,
} from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import { type TsFrameworkVisitor, type TsVisitContext, buildEvidence, resolveCallerUrl, detectExternalUrl, resolveIdentifierTypeToDeclaration } from '@adorable/lang-ts';
import { resolveWrapperCall, type WrapperResolution } from './wrapper-resolver.js';
import { resolveFreeFunctionWrapperCall } from './free-function-wrapper.js';

/**
 * Fetch client-side API caller visitor (#78 under #2).
 *
 * Detects call expressions of the form `fetch(url, options?)` and
 * emits canonical `ClientSideAPICaller` nodes for them. The visitor
 * is stateless, framework-agnostic, and applies to any TS/JS project
 * that uses the platform-built-in `fetch` API — no package
 * dependency signal to key off.
 *
 * Extraction:
 *
 *   fetch('/api/users')
 *     → httpMethod: 'GET' (default), urlLiteral: '/api/users',
 *       egressConfidence: 'exact'
 *
 *   fetch('/api/users', { method: 'POST' })
 *     → httpMethod: 'POST', urlLiteral: '/api/users',
 *       egressConfidence: 'exact'
 *
 *   fetch(`/users/${id}`)
 *     → httpMethod: 'GET', urlLiteral: '/users/',
 *       egressConfidence: 'pattern'
 *
 *   fetch(url, { method: dynamicMethod })
 *     → httpMethod: null, urlLiteral: null,
 *       egressConfidence: 'dynamic'
 *
 * Module-top-level calls (no enclosing function) are silently
 * skipped. Every `'dynamic'` or `'pattern'` classification records a
 * `ConfidenceDecision` span event via `@adorable/observability`.
 *
 * Non-goals at this layer:
 *
 *   - User-defined wrappers (`const apiFetch = (p) => fetch(...)`)
 *     — the wrapper itself is a regular function call; the inner
 *     `fetch(...)` is detected at its call site.
 *   - Mapping detected callers to `APIEndpoint` nodes via
 *     `RESOLVES_TO_ENDPOINT` edges — that's the flow stitcher's job.
 *   - Shadowed local `fetch` variables — accepted as a false
 *     positive; type-based detection is future work.
 */
export function createFetchVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      // Wrapper-class invocations: `client.post('Foo', body)` where
      // `client = new PostAPIClient(...)` and `PostAPIClient.post`
      // internally calls fetch. The user-visible call site is what
      // analytic queries care about — without this branch the
      // wrapper's inner fetch is detected once and every use site
      // is invisible (#182, half A).
      if (ctx.enclosingFunction && !isFetchCall(node) && Node.isPropertyAccessExpression(node.getExpression())) {
        const wrapped = resolveWrapperCall(node);
        if (wrapped && wrapped.urlLiteral !== null) {
          emitWrapperCaller(ctx, node, wrapped);
          return;
        }
      }

      // #8b — free-function wrapper invocations: `apiGet('/api/x')`
      // where `apiGet(url) { return fetch(url) }`. Same idea as the
      // class-method branch above, but the callee is a bare
      // identifier instead of a property access. The fetch-name
      // allowlist (FETCH_WRAPPER_NAMES) handles a hardcoded set of
      // common wrapper names; this branch generalizes to any
      // user-defined function whose body forwards a parameter to
      // `fetch(...)`.
      if (
        ctx.enclosingFunction &&
        !isFetchCall(node) &&
        Node.isIdentifier(node.getExpression())
      ) {
        const free = resolveFreeFunctionWrapperCall(node);
        if (free) {
          emitFreeFunctionWrapperCaller(ctx, node, free);
          return;
        }
      }

      if (!isFetchCall(node)) return;

      // No enclosing function → module top-level, nothing to
      // attribute to. Skip silently (mirrors every other framework
      // plugin).
      if (!ctx.enclosingFunction) return;

      const { httpMethod, urlLiteral, egressConfidence, templateSpanCount, templateSegmentCount, templateParts } = analyzeFetchCall(node);

      if (egressConfidence !== 'exact') {
        recordConfidenceDecision('fetch call egress not statically resolvable', {
          'fetch.egress': egressConfidence,
          'fetch.urlLiteral': urlLiteral ?? '<null>',
          'fetch.httpMethod': httpMethod ?? '<null>',
          'call.sourceLine': node.getStartLineNumber(),
        });
      }

      const evidenceConfidence: SourceEvidence['confidence'] =
        egressConfidence === 'exact' ? 'exact' : egressConfidence === 'pattern' ? 'heuristic' : 'inferred';

      const responseHandlers = extractResponseHandlers(node);

      const caller: ClientSideAPICaller = {
        nodeType: 'ClientSideAPICaller',
        id: idFor.clientSideAPICaller({
          sourceFileId: ctx.sourceFile.id,
          sourceLine: node.getStartLineNumber(),
          urlLiteral,
        }),
        functionId: ctx.enclosingFunction.id,
        sourceFileId: ctx.sourceFile.id,
        sourceLine: node.getStartLineNumber(),
        httpMethod,
        urlLiteral,
        egressConfidence,
        templateSpanCount,
        templateSegmentCount,
        ...(templateParts ? { templateParts } : {}),
        framework: 'fetch',
        repository: ctx.sourceFile.repository,
        ...(urlLiteral ? (() => { const ext = detectExternalUrl(urlLiteral); return ext.isExternal ? { isExternal: true, externalHost: ext.host } : {}; })() : {}),
        evidence: buildEvidence(node, ctx.sourceFile.filePath, evidenceConfidence),
        ...(responseHandlers.length > 0 ? { responseHandlers } : {}),
      };
      ctx.emitNode(caller);
      ctx.emitEdge({
        edgeType: 'MAKES_REQUEST',
        from: ctx.enclosingFunction.id,
        to: caller.id,
      });
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Call detection
// ──────────────────────────────────────────────────────────────────────

/**
 * Common fetch wrapper function names. These are treated as equivalent
 * to bare `fetch()` — the first argument is assumed to be the URL.
 */
const FETCH_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'fetch',
  'fetchApi',
  'fetchJSON',
  'apiFetch',
  'httpFetch',
]);

/**
 * True when the call expression's callee is a bare identifier that
 * matches `fetch` or a common fetch wrapper name. Also matches
 * member access patterns like `api.getUsers()` where the method name
 * doesn't matter but the first argument is a URL-like string.
 */
function isFetchCall(call: CallExpression): boolean {
  const callee = call.getExpression();

  // Bare identifier: fetch(), fetchApi(), etc.
  if (Node.isIdentifier(callee)) {
    if (!FETCH_WRAPPER_NAMES.has(callee.getText())) return false;
    // #9 — shadowed-fetch guard. If the identifier resolves to a
    // local function definition (literal arrow, function expression,
    // or function declaration), skip — the user has clearly bound a
    // custom function to the name.
    if (isShadowedByCustomFunction(callee)) return false;
    return true;
  }

  return false;
}

/**
 * #9 — true when the identifier resolves to a local function
 * definition rather than the global `fetch`. Three shapes count:
 *
 *   const fetch = (_url) => null;          // ArrowFunction init
 *   const fetch = function (_url) { ... }; // FunctionExpression init
 *   function fetch(_url) { ... }           // FunctionDeclaration
 *
 * Imported bindings (`import { fetch } from 'undici'`) and aliases
 * of the global (`const fetch = globalThis.fetch`) are intentionally
 * NOT skipped — both represent real HTTP fetches.
 *
 * Non-shadowed call sites resolve to a declaration in `lib.dom.d.ts`
 * (or no declaration at all, depending on the project's `lib`
 * setting). The function-shape match is conservative: lib decls are
 * neither `VariableDeclaration` nor `FunctionDeclaration` in the
 * source-file sense, so the global path is unaffected.
 */
function isShadowedByCustomFunction(ident: Identifier): boolean {
  const symbol = ident.getSymbol();
  if (!symbol) return false;
  for (const decl of symbol.getDeclarations()) {
    // Skip ambient / lib declarations — `fetch` itself is declared
    // as a `FunctionDeclaration` in `lib.dom.d.ts`, so without this
    // gate the guard would match every bare `fetch()` call. Only
    // user-source declarations count as shadowing.
    if (isAmbientOrLibDeclaration(decl)) continue;
    if (Node.isFunctionDeclaration(decl)) return true;
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return true;
      }
    }
  }
  return false;
}

function isAmbientOrLibDeclaration(decl: Node): boolean {
  const file = decl.getSourceFile();
  const filePath = file.getFilePath();
  if (filePath.endsWith('.d.ts')) return true;
  if (filePath.includes('/node_modules/')) return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// URL + method extraction
// ──────────────────────────────────────────────────────────────────────

interface FetchAnalysis {
  httpMethod: string | null;
  urlLiteral: string | null;
  egressConfidence: HttpEgressConfidence;
  templateSpanCount: number | null;
  templateSegmentCount: number | null;
  templateParts: string[] | null;
}

/**
 * Derive the URL literal, HTTP method, and egress confidence from a
 * `fetch(url, options?)` call expression.
 *
 * Confidence levels:
 *   - `exact`: both url and method are statically known. Url is a
 *     string literal or no-substitution template and the method is
 *     either defaulted (GET) or derived from an options object with
 *     a literal `method` key.
 *   - `pattern`: url is a template expression whose head is a static
 *     prefix; method is either statically known or defaulted. We
 *     record the static prefix as the `urlLiteral`.
 *   - `dynamic`: url is a computed expression (identifier, call,
 *     property access, new expression, …) OR the options object's
 *     method is non-literal. Both `urlLiteral` and `httpMethod` can
 *     be `null` in this case.
 */
function analyzeFetchCall(call: CallExpression): FetchAnalysis {
  const args = call.getArguments();
  if (args.length === 0) {
    return { httpMethod: null, urlLiteral: null, egressConfidence: 'dynamic', templateSpanCount: null, templateSegmentCount: null, templateParts: null };
  }

  const urlArg = args[0] as Expression;
  const urlInfo = resolveCallerUrl(urlArg);

  const optionsArg = args.length > 1 ? (args[1] as Expression) : null;
  const methodInfo = extractMethod(optionsArg);

  // Compose confidence — the weaker of the two wins. urlLiteral and
  // templateParts are kept on the caller even when overall confidence
  // collapses to 'dynamic' (because of method); the stitcher uses
  // them when present.
  let confidence: HttpEgressConfidence = 'exact';
  if (urlInfo.egressConfidence === 'dynamic' || methodInfo.confidence === 'dynamic') {
    confidence = 'dynamic';
  } else if (urlInfo.egressConfidence === 'pattern') {
    confidence = 'pattern';
  }

  return {
    httpMethod: methodInfo.method,
    urlLiteral: urlInfo.urlLiteral,
    egressConfidence: confidence,
    templateSpanCount: urlInfo.templateSpanCount,
    templateSegmentCount: urlInfo.templateSegmentCount,
    templateParts: urlInfo.templateParts,
  };
}

// URL extraction now goes through `resolveCallerUrl` (#188 — unifies
// fetch + axios, fixes the truncated-head urlLiteral). The previous
// bespoke TemplateExpression branch (which stored only `head`) is gone;
// `urlLiteral` now reflects the full reconstructed pattern with
// `:p0`, `:p1`, … placeholders for unresolved interpolations.

interface MethodExtraction {
  method: string | null;
  confidence: 'exact' | 'dynamic';
}

function extractMethod(optionsArg: Expression | null): MethodExtraction {
  if (!optionsArg) {
    // No options object → default to GET.
    return { method: 'GET', confidence: 'exact' };
  }
  if (Node.isObjectLiteralExpression(optionsArg)) {
    return extractMethodFromLiteral(optionsArg);
  }
  // #2 — When `optionsArg` is an Identifier, trace it (cross-file
  // capable) to its ultimate ObjectLiteral initializer. Bails to
  // dynamic when the chain ends in a `let`/`var`, a function param,
  // a call expression, etc.
  const resolved = resolveOptionsToObjectLiteral(optionsArg);
  if (resolved) {
    const result = extractMethodFromLiteral(resolved);
    if (result.confidence === 'exact') {
      recordConfidenceDecision('fetch options resolved via identifier indirection (#2)', {
        'fetch.optionsBinding': Node.isIdentifier(optionsArg) ? optionsArg.getText() : '<expr>',
        'fetch.resolvedMethod': result.method ?? '<null>',
        'call.sourceLine': optionsArg.getStartLineNumber(),
      });
    }
    return result;
  }
  // `fetch(url, options)` with a non-resolvable options value —
  // we cannot see into it. Downgrade to dynamic.
  return { method: null, confidence: 'dynamic' };
}

function extractMethodFromLiteral(literal: ObjectLiteralExpression): MethodExtraction {
  const found = findMethodProperty(literal);
  if (!found.present) {
    // Options object is present but has no `method` key → defaults to GET.
    return { method: 'GET', confidence: 'exact' };
  }
  const initializer = found.initializer;
  if (
    initializer &&
    (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer))
  ) {
    return { method: initializer.getLiteralValue().toUpperCase(), confidence: 'exact' };
  }
  // Method key is present but its value is non-literal (identifier,
  // call expression, shorthand property, etc.).
  return { method: null, confidence: 'dynamic' };
}

/**
 * #2 — Trace an `optionsArg` Identifier to the ObjectLiteralExpression
 * it ultimately points to. Cross-file capable.
 *
 * Resolution uses lang-ts's shared `resolveIdentifierTypeToDeclaration`
 * (CLAUDE.md: cross-file symbol resolution belongs in lang-ts, not
 * duplicated per-framework). The predicate accepts any
 * VariableDeclaration; we then unwrap its initializer here so we can
 * recurse through alias chains.
 *
 * Handles:
 *   - `const opts = { method: 'POST' }`
 *   - `const opts: RequestInit = { method: 'POST' }`
 *   - One level of alias chain (`const a = b; const b = {...}`).
 *   - Imported binding (`import { POST_OPTS } from './options'`).
 *
 * Soundness — only `const` declarations are followed. `let`/`var`
 * could be reassigned after declaration, which would make the
 * recovered method silently wrong. The reviewer of #302 caught this:
 *   let opts = { method: 'GET' };
 *   opts = { method: 'POST' };
 *   fetch(url, opts)        // <-- previously would have returned 'GET' exact
 * Returning null for `let`/`var` falls through to `dynamic`, which
 * is the same behavior as before #2 — strictly safer than the prior
 * naive resolution.
 */
function resolveOptionsToObjectLiteral(
  optionsArg: Expression,
  visited: Set<Node> = new Set(),
  depth = 0,
): ObjectLiteralExpression | null {
  if (depth > 8) return null;
  if (visited.has(optionsArg)) return null;
  visited.add(optionsArg);

  if (!Node.isIdentifier(optionsArg)) return null;

  const decl = resolveIdentifierTypeToDeclaration(
    optionsArg,
    (d) => Node.isVariableDeclaration(d),
  );
  if (!decl || !Node.isVariableDeclaration(decl)) return null;

  // Reassignment guard — only `const` is sound to follow.
  const stmt = decl.getVariableStatement();
  if (stmt && stmt.getDeclarationKind() !== VariableDeclarationKind.Const) {
    return null;
  }

  const init = decl.getInitializer();
  if (!init) return null;
  if (Node.isObjectLiteralExpression(init)) return init;
  // Alias chain — recurse via the same helper.
  if (Node.isIdentifier(init)) {
    return resolveOptionsToObjectLiteral(init, visited, depth + 1);
  }
  return null;
}

/**
 * Find the `method` property inside a fetch options object literal.
 * Handles three property shapes:
 *
 *   - `{ method: 'POST' }`   — PropertyAssignment with identifier key
 *   - `{ 'method': 'POST' }` — PropertyAssignment with string key
 *   - `{ method }`           — ShorthandPropertyAssignment
 *
 * Returns `{ present: false }` when no `method` key is declared (the
 * caller defaults to GET). Returns `{ present: true, initializer }`
 * when the key exists; the initializer is `null` for shorthand
 * assignments (always dynamic since the value is an identifier).
 */
type MethodPropertyLookup =
  | { present: true; initializer: Expression | null }
  | { present: false };

function findMethodProperty(options: ObjectLiteralExpression): MethodPropertyLookup {
  for (const prop of options.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const nameNode = prop.getNameNode();
      let name: string;
      if (Node.isIdentifier(nameNode)) {
        name = nameNode.getText();
      } else if (Node.isStringLiteral(nameNode)) {
        name = nameNode.getLiteralValue();
      } else {
        continue;
      }
      if (name === 'method') {
        return { present: true, initializer: prop.getInitializer() ?? null };
      }
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      if (prop.getName() === 'method') {
        // Shorthand — value is an identifier reference, not a literal.
        return { present: true, initializer: null };
      }
    }
  }
  return { present: false };
}

// ──────────────────────────────────────────────────────────────────────
// Response chain extraction (#108)
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract response handlers from the `.then()` chain following a
 * `fetch()` call. Detects three patterns:
 *
 *   fetch(url).then(r => r.json())     → { kind: 'json-parse' }
 *   fetch(url).then(r => r.json()).then(setUsers) → { kind: 'state-update', targetStateVar: 'users' }
 *   fetch(url).catch(err => ...)       → { kind: 'error-handler' }
 *
 * The `node` parameter is the `fetch()` CallExpression. We walk up
 * through parent PropertyAccessExpression + CallExpression pairs to
 * find `.then()` and `.catch()` calls.
 */
function extractResponseHandlers(fetchCall: CallExpression): ResponseHandler[] {
  const handlers: ResponseHandler[] = [];
  let current: Node = fetchCall;

  // Walk up through .then()/.catch() chain.
  // AST shape: fetch().then(cb) is:
  //   CallExpression (.then call)
  //     PropertyAccessExpression
  //       CallExpression (fetch)
  //       .then
  //     cb (argument)
  for (let i = 0; i < 10; i++) {
    const parent = current.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) break;

    const methodName = parent.getNameNode().getText();
    if (methodName !== 'then' && methodName !== 'catch') break;

    const outerCall = parent.getParent();
    if (!outerCall || !Node.isCallExpression(outerCall)) break;

    const args = outerCall.getArguments();
    if (args.length === 0) {
      current = outerCall;
      continue;
    }

    const callback = args[0];

    if (methodName === 'catch') {
      handlers.push({
        kind: 'error-handler',
        expression: truncateText(callback.getText(), 100),
        targetStateVar: null,
        sourceLine: outerCall.getStartLineNumber(),
      });
      current = outerCall;
      continue;
    }

    // .then() — determine if it's a JSON parse or a state update.
    if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
      const bodyText = callback.getText();
      if (bodyText.includes('.json()')) {
        handlers.push({
          kind: 'json-parse',
          expression: 'r.json()',
          targetStateVar: null,
          sourceLine: outerCall.getStartLineNumber(),
        });
      } else {
        handlers.push({
          kind: 'other',
          expression: truncateText(bodyText, 100),
          targetStateVar: null,
          sourceLine: outerCall.getStartLineNumber(),
        });
      }
    } else if (Node.isIdentifier(callback)) {
      // .then(setUsers) — likely a React useState setter.
      const name = callback.getText();
      // Guard against non-React set* names.
      const NON_STATE_SETTERS = new Set([
        'setInterval', 'setTimeout', 'setAttribute', 'setItem',
        'setProperty', 'setRequestHeader', 'setPrototypeOf',
      ]);
      const isStateSetter = name.startsWith('set') && name.length > 3
        && !NON_STATE_SETTERS.has(name);
      const stateVar = isStateSetter
        ? name.charAt(3).toLowerCase() + name.slice(4)
        : null;
      handlers.push({
        kind: isStateSetter ? 'state-update' : 'other',
        expression: name,
        targetStateVar: stateVar,
        sourceLine: outerCall.getStartLineNumber(),
      });
    }

    current = outerCall;
  }

  // Await pattern: if fetch is inside an AwaitExpression, look for
  // subsequent set() / setState calls in the same block. This covers
  // Zustand stores: `const data = await fetchApi(...); set({ data })`.
  if (handlers.length === 0) {
    const awaitHandlers = extractAwaitPatternHandlers(fetchCall);
    handlers.push(...awaitHandlers);
  }

  return handlers;
}

/**
 * For await-based fetch patterns, scan subsequent statements in the
 * same block for state-update calls (Zustand `set()`, React `setState`).
 */
function extractAwaitPatternHandlers(fetchCall: CallExpression): ResponseHandler[] {
  const handlers: ResponseHandler[] = [];

  // Walk up to find the AwaitExpression wrapping this fetch call.
  let awaitNode: Node | undefined = fetchCall.getParent();
  while (awaitNode && !Node.isAwaitExpression(awaitNode)) {
    if (Node.isBlock(awaitNode) || Node.isFunctionDeclaration(awaitNode) ||
        Node.isArrowFunction(awaitNode) || Node.isFunctionExpression(awaitNode)) {
      return handlers;
    }
    awaitNode = awaitNode.getParent();
  }
  if (!awaitNode) return handlers;

  // Walk up to the statement containing the await.
  let stmt: Node | undefined = awaitNode.getParent();
  while (stmt && !Node.isExpressionStatement(stmt) && !Node.isVariableStatement(stmt)) {
    stmt = stmt.getParent();
  }
  if (!stmt) return handlers;

  // Get the parent block and find subsequent statements.
  const block = stmt.getParent();
  if (!block || !Node.isBlock(block)) return handlers;

  const statements = block.getStatements();
  const stmtIndex = statements.findIndex((s) => s === stmt || s.getPos() === stmt.getPos());
  if (stmtIndex < 0) return handlers;

  // Scan subsequent statements for set() / setState() calls.
  for (let i = stmtIndex + 1; i < Math.min(statements.length, stmtIndex + 5); i++) {
    const sibling = statements[i];
    const calls = sibling.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      if (!Node.isCallExpression(call)) continue;
      const callee = call.getExpression();
      if (Node.isIdentifier(callee)) {
        const name = callee.getText();
        // Zustand: set({...})
        if (name === 'set') {
          handlers.push({
            kind: 'state-update',
            expression: 'set()',
            targetStateVar: null,
            sourceLine: call.getStartLineNumber(),
          });
        }
        // React: setState / setXxx
        if (name.startsWith('set') && name.length > 3 && name !== 'setInterval' && name !== 'setTimeout') {
          const stateVar = name.charAt(3).toLowerCase() + name.slice(4);
          handlers.push({
            kind: 'state-update',
            expression: name,
            targetStateVar: stateVar,
            sourceLine: call.getStartLineNumber(),
          });
        }
      }
    }
  }

  return handlers;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ──────────────────────────────────────────────────────────────────────
// Wrapper-class call sites (#182, half A)
// ──────────────────────────────────────────────────────────────────────

function emitWrapperCaller(
  ctx: TsVisitContext,
  call: CallExpression,
  wrapped: WrapperResolution,
): void {
  if (!ctx.enclosingFunction) return;
  const egressConfidence: HttpEgressConfidence = wrapped.exact ? 'exact' : 'pattern';
  const evidenceConfidence: SourceEvidence['confidence'] = wrapped.exact ? 'exact' : 'heuristic';

  if (!wrapped.exact) {
    recordConfidenceDecision('wrapper-class fetch call resolved with dynamic spans', {
      'fetch.urlLiteral': wrapped.urlLiteral ?? '<null>',
      'fetch.httpMethod': wrapped.httpMethod ?? '<null>',
      'wrapper.firstArg': wrapped.firstArgLiteral ?? '<null>',
      'call.sourceLine': call.getStartLineNumber(),
    });
  }

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine: call.getStartLineNumber(),
      urlLiteral: wrapped.urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine: call.getStartLineNumber(),
    httpMethod: wrapped.httpMethod,
    urlLiteral: wrapped.urlLiteral,
    egressConfidence,
    templateSpanCount: null,
    templateSegmentCount: null,
    ...(wrapped.templateParts && wrapped.templateParts.length > 0
      ? { templateParts: wrapped.templateParts }
      : {}),
    framework: 'fetch',
    repository: ctx.sourceFile.repository,
    ...(wrapped.urlLiteral
      ? (() => {
          const ext = detectExternalUrl(wrapped.urlLiteral!);
          return ext.isExternal ? { isExternal: true, externalHost: ext.host } : {};
        })()
      : {}),
    evidence: buildEvidence(call, ctx.sourceFile.filePath, evidenceConfidence),
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Free-function wrapper call sites (#8b)
// ──────────────────────────────────────────────────────────────────────

function emitFreeFunctionWrapperCaller(
  ctx: TsVisitContext,
  call: CallExpression,
  resolved: { urlLiteral: string; httpMethod: string },
): void {
  if (!ctx.enclosingFunction) return;
  recordConfidenceDecision('free-function fetch wrapper call resolved (#8b)', {
    'fetch.urlLiteral': resolved.urlLiteral,
    'fetch.httpMethod': resolved.httpMethod,
    'fetch.wrapperName': call.getExpression().getText(),
    'call.sourceLine': call.getStartLineNumber(),
  });

  const caller: ClientSideAPICaller = {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine: call.getStartLineNumber(),
      urlLiteral: resolved.urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine: call.getStartLineNumber(),
    httpMethod: resolved.httpMethod,
    urlLiteral: resolved.urlLiteral,
    egressConfidence: 'exact',
    templateSpanCount: null,
    templateSegmentCount: null,
    framework: 'fetch',
    repository: ctx.sourceFile.repository,
    ...(() => {
      const ext = detectExternalUrl(resolved.urlLiteral);
      return ext.isExternal ? { isExternal: true, externalHost: ext.host } : {};
    })(),
    evidence: buildEvidence(call, ctx.sourceFile.filePath, 'exact'),
  };
  ctx.emitNode(caller);
  ctx.emitEdge({
    edgeType: 'MAKES_REQUEST',
    from: ctx.enclosingFunction.id,
    to: caller.id,
  });
}
