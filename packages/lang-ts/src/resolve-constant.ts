import { Node, SyntaxKind } from 'ts-morph';

/**
 * Attempt to resolve an AST expression to a compile-time string value.
 * Handles:
 *   - String literals: 'hello'
 *   - No-substitution template literals: `hello`
 *   - Const variable declarations: const URL = '/api/users'
 *   - Object property access: ApiConstant.LOGIN → 'auth/login'
 *   - Enum members: HttpMethod.GET → 'GET'
 *
 * Returns null if the expression can't be statically resolved.
 * Does NOT follow function calls, conditionals, or dynamic expressions.
 */
const MAX_RESOLVE_DEPTH = 10;

export function resolveToString(expr: Node, depth = 0): string | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;

  // Direct string literal.
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }

  // Template literal with all-static spans — fold into a single string.
  if (Node.isTemplateExpression(expr)) {
    return resolveTemplateExpressionToString(expr, depth);
  }

  // Identifier → follow to declaration.
  if (Node.isIdentifier(expr)) {
    return resolveIdentifierToString(expr, depth);
  }

  // Property access: obj.prop → follow to property value.
  if (Node.isPropertyAccessExpression(expr)) {
    return resolvePropertyAccessToString(expr, depth);
  }

  // Binary expression with + for string concatenation: 'a' + 'b'
  if (Node.isBinaryExpression(expr)) {
    const left = resolveToString(expr.getLeft(), depth + 1);
    const right = resolveToString(expr.getRight(), depth + 1);
    if (left !== null && right !== null) return left + right;
  }

  // Call expression — pure-function evaluation (#193). Inlines the
  // called function's body when it's a single `return <stringExpr>`
  // (or arrow-with-expression-body), substituting call-site args for
  // parameter references. Bails on branching, multi-statement, or
  // side-effecting bodies.
  if (Node.isCallExpression(expr)) {
    return resolveCallExpressionToString(expr, depth);
  }

  return null;
}

function resolveTemplateExpressionToString(expr: Node, depth: number): string | null {
  if (!Node.isTemplateExpression(expr)) return null;
  let result = expr.getHead().getLiteralText();
  for (const span of expr.getTemplateSpans()) {
    const piece = resolveToString(span.getExpression(), depth + 1);
    if (piece === null) return null;
    result += piece + span.getLiteral().getLiteralText();
  }
  return result;
}

function resolveIdentifierToString(id: Node, depth: number): string | null {
  if (!Node.isIdentifier(id)) return null;

  const symbol = id.getSymbol();
  if (!symbol) return null;

  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;

  const decl = decls[0];

  // const URL = '/api/users'
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init) return resolveToString(init, depth + 1);
  }

  // Enum member: enum Foo { BAR = 'baz' }
  if (Node.isEnumMember(decl)) {
    const init = decl.getInitializer();
    if (init) return resolveToString(init, depth + 1);
    // Numeric enum without initializer — not a string.
    return null;
  }

  // Cross-file: `import { X } from './m'` (or default / namespace).
  // Without this, identifiers imported from another file land at the
  // ImportSpecifier and return null even though their producer is a
  // `const X = '...'`. Follow the import to the producer and recurse
  // on its initializer.
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    const impDecl = decl.getFirstAncestor((a) => Node.isImportDeclaration(a));
    if (!impDecl || !Node.isImportDeclaration(impDecl)) return null;
    const targetFile = impDecl.getModuleSpecifierSourceFile();
    if (!targetFile) return null;
    const exportName = Node.isImportSpecifier(decl)
      ? decl.getName()
      : Node.isImportClause(decl)
      ? 'default'
      : null;
    if (!exportName) return null;
    const exported = targetFile.getExportedDeclarations().get(exportName);
    if (!exported || exported.length === 0) return null;
    for (const e of exported) {
      if (Node.isVariableDeclaration(e)) {
        const init = e.getInitializer();
        if (init) {
          const s = resolveToString(init, depth + 1);
          if (s !== null) return s;
        }
      }
    }
    return null;
  }

  return null;
}

/**
 * Pure-function evaluator (#193).
 *
 * Inlines a function call when the called function's body is shaped
 * as a single `return <stringExpr>` (block-bodied) or a direct
 * expression body (arrow-bodied). Substitutes the call-site arguments
 * for parameter references in the body, then re-runs `resolveToString`
 * on the result.
 *
 * Conservative on purpose:
 *   - Bails on multi-statement bodies, branches, or any non-return
 *     statement before the return.
 *   - Bails when the call target has overloads or isn't a plain
 *     function declaration / variable-bound function expression.
 *   - Bails when a parameter reference doesn't resolve.
 *
 * Examples it CAN evaluate:
 *   function getRoute(p: string) { return p + '/users/:id'; }
 *   const buildSdkRoute = (base) => base + '/sdk/:version/:name';
 *   getSdkDocPageExpressRouteExpression(vars.jade.onlineDocsBaseUrl)
 */
function resolveCallExpressionToString(expr: Node, depth: number, parentSubs?: Map<string, Node>): string | null {
  if (!Node.isCallExpression(expr)) return null;

  const callee = expr.getExpression();
  if (!Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) return null;

  const fnDecl = resolveCallTarget(callee);
  if (!fnDecl) return null;

  const fnInfo = extractPureFnInfo(fnDecl);
  if (!fnInfo) return null;

  // Build parameter→argument substitution map. When the parent caller
  // is itself inside a pure-function inlining (parentSubs supplied),
  // resolve each argument THROUGH that map first so an Identifier arg
  // like `outer(p)` correctly threads `p`'s binding into `inner`.
  const args = expr.getArguments();
  const subs = new Map<string, Node>();
  for (let i = 0; i < fnInfo.params.length && i < args.length; i++) {
    const arg = args[i] as Node;
    if (parentSubs && Node.isIdentifier(arg)) {
      const parentSub = parentSubs.get(arg.getText());
      if (parentSub) {
        subs.set(fnInfo.params[i]!.getName(), parentSub);
        continue;
      }
    }
    subs.set(fnInfo.params[i]!.getName(), arg);
  }

  return resolveExpressionWithSubs(fnInfo.bodyExpr, subs, depth + 1);
}

interface PureFnInfo {
  params: ReturnType<typeof getParameters>;
  bodyExpr: Node;
}

function resolveCallTarget(callee: Node): Node | null {
  const identifier = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
  if (!Node.isIdentifier(identifier)) return null;
  const symbol = identifier.getSymbol();
  if (!symbol) return null;
  for (const decl of symbol.getDeclarations()) {
    // Function declaration: `function f(...) { ... }`
    if (Node.isFunctionDeclaration(decl)) return decl;
    // Variable bound to an arrow / fn expression: `const f = (...) => { ... };`
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return decl;
      }
    }
    // Method on a class — out of scope (would need `this` substitution).
    // Imported binding — follow the alias chain via symbol declarations
    // (ts-morph handles this transparently when getSymbol returns the
    // alias's declaration).
  }
  return null;
}

function getParameters(decl: Node) {
  if (Node.isFunctionDeclaration(decl)) return decl.getParameters();
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init.getParameters();
    }
  }
  return [];
}

function extractPureFnInfo(decl: Node): PureFnInfo | null {
  let params = getParameters(decl);
  let body: Node | undefined;
  if (Node.isFunctionDeclaration(decl)) {
    body = decl.getBody();
  } else if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      body = init.getBody();
      params = init.getParameters();
    }
  }
  if (!body) return null;

  // Block body: must be exactly one ReturnStatement with an expression.
  if (Node.isBlock(body)) {
    const stmts = body.getStatements();
    if (stmts.length !== 1) return null;
    const stmt = stmts[0];
    if (!Node.isReturnStatement(stmt)) return null;
    const ret = stmt.getExpression();
    if (!ret) return null;
    return { params, bodyExpr: ret };
  }
  // Arrow with expression body — body IS the return expression.
  return { params, bodyExpr: body };
}

/**
 * Walk an expression and resolve it to a string, treating any
 * Identifier whose name is in `subs` as the substituted node. Used to
 * inline a function body's parameter references before resolving.
 */
function resolveExpressionWithSubs(node: Node, subs: Map<string, Node>, depth: number): string | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isIdentifier(node)) {
    const sub = subs.get(node.getText());
    if (sub) return resolveToString(sub, depth + 1);
    return resolveToString(node, depth + 1);
  }
  if (Node.isPropertyAccessExpression(node)) {
    // PropertyAccess like `prefix.url` where `prefix` might be a
    // substituted parameter. Try substituting the receiver first.
    const recName = node.getExpression();
    if (Node.isIdentifier(recName)) {
      const sub = subs.get(recName.getText());
      if (sub) {
        // Resolve the substitute, then look up the property on it.
        // For simple cases (sub is itself a PropertyAccess that already
        // resolves to a string), `resolveToString` gives us nothing
        // useful — the caller passed us a substring, not an object.
        // Fall through to the normal resolver.
      }
    }
    return resolveToString(node, depth + 1);
  }
  if (Node.isBinaryExpression(node)) {
    const left = resolveExpressionWithSubs(node.getLeft(), subs, depth + 1);
    const right = resolveExpressionWithSubs(node.getRight(), subs, depth + 1);
    if (left !== null && right !== null) return left + right;
    return null;
  }
  if (Node.isTemplateExpression(node)) {
    let result = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      const piece = resolveExpressionWithSubs(span.getExpression(), subs, depth + 1);
      if (piece === null) return null;
      result += piece + span.getLiteral().getLiteralText();
    }
    return result;
  }
  if (Node.isCallExpression(node)) {
    // Thread `subs` so any Identifier args (parameters of the outer
    // function) resolve through the substitution map rather than
    // failing back to declaration lookup.
    return resolveCallExpressionToString(node, depth + 1, subs);
  }
  return null;
}

function resolvePropertyAccessToString(expr: Node, depth: number): string | null {
  if (!Node.isPropertyAccessExpression(expr)) return null;

  const propName = expr.getNameNode().getText();
  const receiver = expr.getExpression();

  // Try to resolve via symbol (works for imported constants).
  const symbol = expr.getNameNode().getSymbol();
  if (symbol) {
    const decls = symbol.getDeclarations();
    for (const decl of decls) {
      // Object literal property: { LOGIN: 'auth/login' }
      if (Node.isPropertyAssignment(decl)) {
        const init = decl.getInitializer();
        if (init) {
          const value = resolveToString(init, depth + 1);
          if (value !== null) return value;
        }
      }
      // Shorthand property: { LOGIN } where LOGIN is a variable
      if (Node.isShorthandPropertyAssignment(decl)) {
        const value = resolveIdentifierToString(decl.getNameNode(), depth + 1);
        if (value !== null) return value;
      }
      // Enum member
      if (Node.isEnumMember(decl)) {
        const init = decl.getInitializer();
        if (init) return resolveToString(init, depth + 1);
      }
      // Namespace-imported const: `import * as ActionType from './x'`
      // resolves `ActionType.LOGIN` to the exported VariableDeclaration
      // `export const LOGIN = '...'`.
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init) {
          const value = resolveToString(init, depth + 1);
          if (value !== null) return value;
        }
      }
    }
  }

  // Fallback: resolve the receiver to an object literal and find the property.
  const receiverObject = resolveReceiverToObjectLiteral(receiver, depth);
  if (receiverObject) {
    for (const prop of receiverObject.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const name = prop.getNameNode();
        if (Node.isIdentifier(name) && name.getText() === propName) {
          const propInit = prop.getInitializer();
          if (propInit) return resolveToString(propInit, depth + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Walk a property-access receiver back to an ObjectLiteralExpression
 * declaration. Used by `resolvePropertyAccessToString` to handle
 * chained accesses like `vars.jade.jadeDownloadUrl` (#407):
 *
 *   - `vars` (Identifier) → const vars = { jade: { jadeDownloadUrl: '...' } }
 *     follows the symbol to the declaration's initializer.
 *   - `vars.jade` (PropertyAccessExpression) → recurse on `vars`, find
 *     `jade`, return its object-literal initializer.
 *
 * Also follows ImportSpecifier (named) / ImportClause (default) to
 * the producer file's exported VariableDeclaration with an
 * ObjectLiteralExpression initializer, so
 *   `import vars from './vars'` (default-imported object literal)
 *   `import { config } from './config'` (named-imported object literal)
 * both resolve. NamespaceImport intentionally not handled here — the
 * receiver in `ns.config.api.base` would be `ns.config`, not `ns`
 * itself, and a NamespaceImport binding has no single canonical
 * "exported name" to follow.
 */
function resolveReceiverToObjectLiteral(
  receiver: Node,
  depth: number,
): import('ts-morph').ObjectLiteralExpression | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  if (Node.isParenthesizedExpression(receiver)) {
    return resolveReceiverToObjectLiteral(receiver.getExpression(), depth + 1);
  }
  // Direct object-literal initializer was passed in (rare; mostly
  // appears as a sub-walk result of a nested resolve).
  if (Node.isObjectLiteralExpression(receiver)) return receiver;

  // Chained: receiver is itself a PropertyAccessExpression — recurse
  // on its receiver first, then look up the property name.
  if (Node.isPropertyAccessExpression(receiver)) {
    const innerObj = resolveReceiverToObjectLiteral(receiver.getExpression(), depth + 1);
    if (!innerObj) return null;
    const propName = receiver.getNameNode().getText();
    for (const prop of innerObj.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const name = prop.getNameNode();
        if (Node.isIdentifier(name) && name.getText() === propName) {
          const init = prop.getInitializer();
          if (init) return resolveReceiverToObjectLiteral(init, depth + 1);
        }
      }
    }
    return null;
  }

  if (!Node.isIdentifier(receiver)) return null;
  const sym = receiver.getSymbol();
  if (!sym) return null;
  for (const decl of sym.getDeclarations()) {
    // Local `const vars = { … }` or namespace-import target.
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isObjectLiteralExpression(init)) return init;
      if (init && Node.isParenthesizedExpression(init)) {
        const inner = init.getExpression();
        if (Node.isObjectLiteralExpression(inner)) return inner;
      }
    }
    // Cross-file imports: follow to the producer file's exported
    // VariableDeclaration with an ObjectLiteral initializer (#407).
    if (
      Node.isImportSpecifier(decl) ||
      Node.isImportClause(decl) ||
      Node.isNamespaceImport(decl)
    ) {
      const impDecl = decl.getFirstAncestor((a) => Node.isImportDeclaration(a));
      if (!impDecl || !Node.isImportDeclaration(impDecl)) continue;
      const targetFile = impDecl.getModuleSpecifierSourceFile();
      if (!targetFile) continue;
      const exportName = Node.isImportSpecifier(decl)
        ? decl.getName()
        : Node.isImportClause(decl)
        ? 'default'
        : null;
      if (!exportName) continue;
      const exported = targetFile.getExportedDeclarations().get(exportName);
      if (!exported || exported.length === 0) continue;
      for (const e of exported) {
        if (Node.isVariableDeclaration(e)) {
          const init = e.getInitializer();
          if (init && Node.isObjectLiteralExpression(init)) return init;
        }
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Partial URL pattern resolution (#179)
// ──────────────────────────────────────────────────────────────────────

/**
 * The output of `resolveUrlPattern` — a partially-resolved URL pattern
 * with the resolvable parts inlined and the unresolved expressions left
 * as `${name}` placeholders. Designed so the URL stitcher can match
 * against routes like `/songs/:id/like` even when the caller's URL is
 * built from `ApiConstant.X + variable + "literal"`.
 */
export interface UrlPattern {
  /** The pattern string. Resolved chunks are inlined, unresolved chunks
   *  appear as `${expr-text}`. e.g., for
   *    `ApiConstant.SONGS + id + "/like"`  with `ApiConstant.SONGS="songs/"`:
   *    → `"songs/${id}/like"`. */
  pattern: string;
  /** Pieces of the pattern between unresolved gaps. The URL stitcher's
   *  templateParts-based matcher reconstructs `<part0>:p0<part1>:p1…` and
   *  matches against endpoint route patterns. e.g.:
   *    `["songs/", "/like"]`  → reconstructed as `songs/:p0/like`
   *    matches endpoint pattern `/songs/:id/like`. */
  templateParts: string[];
  /** Number of unresolved gaps (= templateParts.length - 1). */
  templateSpanCount: number;
  /** True iff every chunk resolved (caller can use confidence='exact'). */
  fullyResolved: boolean;
}

export interface ResolveUrlPatternOptions {
  /**
   * Strip query strings (`?…`) from the resolved pattern and
   * templateParts. Defaults to `true` for backward compatibility with
   * the original stitcher-oriented call sites — endpoint route patterns
   * don't include query strings, so stripping helps segment matching.
   *
   * Visitor emit paths (`resolveCallerUrl`) pass `false` so dispatcher
   * shapes like `${url}?r=${name}` survive into `urlLiteral` /
   * `templateParts` rather than collapsing to an all-empty result
   * (the request-name dispatcher in #194 lives entirely in the query).
   */
  stripQuery?: boolean;
}

/**
 * Resolve a URL expression to a partial pattern. Walks `+` concatenations
 * and template-expression spans, calling `resolveToString` on each piece
 * and falling back to a `${expr-text}` placeholder when a piece doesn't
 * resolve. Returns null when nothing resolves to literal content (the
 * caller is then fully dynamic).
 */
export function resolveUrlPattern(
  expr: Node,
  options: ResolveUrlPatternOptions = {}
): UrlPattern | null {
  const stripQuery = options.stripQuery ?? true;
  type Chunk = { kind: 'static'; text: string } | { kind: 'placeholder'; text: string };
  const chunks: Chunk[] = [];

  function collect(node: Node, depth: number): void {
    if (depth > MAX_RESOLVE_DEPTH) {
      chunks.push({ kind: 'placeholder', text: node.getText() });
      return;
    }
    // String literal / no-substitution template — direct static.
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      chunks.push({ kind: 'static', text: node.getLiteralValue() });
      return;
    }
    // Template expression — walk head + each span.
    if (Node.isTemplateExpression(node)) {
      chunks.push({ kind: 'static', text: node.getHead().getLiteralText() });
      for (const span of node.getTemplateSpans()) {
        const spanExpr = span.getExpression();
        const r = resolveToString(spanExpr, depth + 1);
        if (r !== null) chunks.push({ kind: 'static', text: r });
        else chunks.push({ kind: 'placeholder', text: spanExpr.getText() });
        chunks.push({ kind: 'static', text: span.getLiteral().getLiteralText() });
      }
      return;
    }
    // `a + b` concatenation — descend both sides so left-associative
    // chains like `A + B + C + D` flatten properly.
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      collect(node.getLeft(), depth + 1);
      collect(node.getRight(), depth + 1);
      return;
    }
    // Identifier / property access / anything else — try the full
    // constant resolver first (handles enums, imported constants, etc.);
    // fall through to placeholder if it doesn't resolve.
    const r = resolveToString(node, depth);
    if (r !== null) chunks.push({ kind: 'static', text: r });
    else chunks.push({ kind: 'placeholder', text: node.getText() });
  }

  collect(expr, 0);
  if (chunks.length === 0) return null;

  // Strip the query string when requested. `?` can appear inside any
  // static chunk, not only the last. Once we hit one, truncate that
  // chunk at `?` and drop every subsequent chunk (placeholders included
  // — they're inside the query string we don't want to match against
  // route patterns).
  let truncated: typeof chunks;
  if (stripQuery) {
    truncated = [];
    for (const c of chunks) {
      if (c.kind === 'placeholder') {
        truncated.push(c);
        continue;
      }
      const q = c.text.indexOf('?');
      if (q < 0) {
        truncated.push(c);
      } else {
        if (q > 0) truncated.push({ kind: 'static', text: c.text.slice(0, q) });
        break;
      }
    }
  } else {
    truncated = chunks;
  }
  if (truncated.length === 0) return null;

  // Build the human-readable pattern from the truncated chunks.
  let pattern = '';
  let placeholderCount = 0;
  for (const c of truncated) {
    if (c.kind === 'static') pattern += c.text;
    else { pattern += '${' + c.text + '}'; placeholderCount += 1; }
  }

  // Build templateParts — concatenate consecutive static chunks; split at
  // placeholder boundaries.
  const parts: string[] = [];
  let current = '';
  for (const c of truncated) {
    if (c.kind === 'static') current += c.text;
    else { parts.push(current); current = ''; }
  }
  parts.push(current);

  // Drop pure-dynamic results (no static literal content survived). Lets
  // the caller treat them as `dynamic` rather than emitting an empty pattern.
  if (parts.every((p) => p === '')) return null;

  return {
    pattern,
    templateParts: parts,
    templateSpanCount: placeholderCount,
    fullyResolved: placeholderCount === 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Caller URL resolution (#188 — shared by framework-fetch / framework-axios)
// ──────────────────────────────────────────────────────────────────────

/**
 * Reconstruct a `:p0`-style URL pattern from a `templateParts` array.
 * Mirrors the stitcher's internal reconstruction at
 * `flow-stitcher/src/url-matcher.ts:138-141` so the value stored on
 * `ClientSideAPICaller.urlLiteral` is what the stitcher already
 * compares against when matching routes.
 *
 *   ['/projects/', '/diagrams']    → '/projects/:p0/diagrams'
 *   ['', '/api/users']             → ':p0/api/users'
 *   ['/api/users']                 → '/api/users'         (no placeholders)
 */
export function reconstructFromParts(parts: string[]): string {
  return parts
    .map((part, i) => i < parts.length - 1 ? part + `:p${i}` : part)
    .join('');
}

export interface CallerUrlInfo {
  urlLiteral: string | null;
  egressConfidence: 'exact' | 'pattern' | 'dynamic';
  templateSpanCount: number | null;
  templateSegmentCount: number | null;
  templateParts: string[] | null;
}

/**
 * Resolve a client-side API call's URL argument into the standard
 * `ClientSideAPICaller` URL fields (#188).
 *
 *   - String literal / no-substitution template → `exact`, urlLiteral
 *     is the literal value.
 *   - Anything that `resolveUrlPattern` reduces to a fully-resolved
 *     literal → `exact`, urlLiteral is the resolved pattern.
 *   - Anything that resolves to a partial pattern (template spans,
 *     binary `+`, identifier-bound concat) → `pattern`. urlLiteral is
 *     the `:p0`-style reconstruction (so consumers like
 *     `list_client_api_calls` see the full URL shape, not the static
 *     head). `templateParts` carries the bare-slot form the stitcher
 *     consumes.
 *   - Nothing static recovered → `dynamic`, all fields null.
 *
 * Both fetch and axios visitors call into this so the two paths are
 * symmetric (issue #188 Cause 3 — fetch had a narrower bespoke path).
 */
export function resolveCallerUrl(expr: Node): CallerUrlInfo {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return {
      urlLiteral: expr.getLiteralValue(),
      egressConfidence: 'exact',
      templateSpanCount: null,
      templateSegmentCount: null,
      templateParts: null,
    };
  }

  // Visitor-emit paths preserve query strings so dispatcher patterns
  // like `${url}?r=${name}` survive into urlLiteral / templateParts.
  // The stitcher already handles caller URLs with queries via the
  // wrapper-resolver path (#182, half A); keeping them symmetric here
  // avoids losing the bare-fetch dispatcher case.
  const resolved = resolveUrlPattern(expr, { stripQuery: false });
  if (!resolved) {
    return {
      urlLiteral: null,
      egressConfidence: 'dynamic',
      templateSpanCount: null,
      templateSegmentCount: null,
      templateParts: null,
    };
  }

  if (resolved.fullyResolved) {
    return {
      urlLiteral: resolved.pattern,
      egressConfidence: 'exact',
      templateSpanCount: null,
      templateSegmentCount: null,
      templateParts: null,
    };
  }

  // Partial pattern: compute :p0-style urlLiteral and segment count.
  let segCount = 0;
  for (const part of resolved.templateParts) {
    const trimmed = part.replace(/^\/+/, '').replace(/\/+$/, '');
    if (trimmed.length > 0) segCount += trimmed.split('/').length;
  }
  return {
    urlLiteral: reconstructFromParts(resolved.templateParts),
    egressConfidence: 'pattern',
    templateSpanCount: resolved.templateSpanCount,
    templateSegmentCount: segCount + resolved.templateSpanCount,
    templateParts: resolved.templateParts,
  };
}

/**
 * Detect whether a URL string targets an external service.
 * External = absolute URL with a hostname containing a dot (public domain).
 * Internal = relative path, localhost, 127.0.0.1, or bare hostname (service name).
 *
 * Returns `{ isExternal: true, host }` or `{ isExternal: false, host: null }`.
 */
export { detectExternalUrl } from '@veoable/plugin-api';
