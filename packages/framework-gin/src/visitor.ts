import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';
import type { HandlerMap } from './handler-resolver.js';

/**
 * Gin framework visitor (#22, #204 prefix composition).
 *
 * Detects API endpoints declared via:
 *   router.GET("/path", handler)
 *   router.POST("/path", handler)
 *   router.PUT, .DELETE, .PATCH, .HEAD, .OPTIONS
 *   router.Any("/path", handler)       → ALL
 *   router.Handle("METHOD", "/path", handler)
 *
 * Composes route group prefixes (#204):
 *   router := gin.Default()
 *   api := router.Group("/api")
 *   v1  := api.Group("/v1")
 *   v1.GET("/profile", getProfile)              →  /api/v1/profile
 *
 * The visitor pre-scans the file for `<id> := <other>.Group("/x")`
 * and `var <id> = <other>.Group("/x")` shapes, then composes the
 * resolved prefix when a route method fires on `<id>`.
 *
 * Conservative on purpose:
 *   - Same-file only.
 *   - Group prefix must be a string literal.
 *   - All bindings share one namespace; cross-function prefix flow
 *     (passing `*gin.RouterGroup` to another function) is out of scope.
 *
 * Only matches files that import `github.com/gin-gonic/gin`.
 *
 * Handler resolution (#523-style follow-up): when a `handlerMap` is
 * supplied by the plugin's project-load pass, the visitor extracts
 * the handler arg's method or function name from
 * `r.GET("/x", v.List)` / `r.GET("/x", handleX)` and looks it up in
 * the project-wide name map. When the name resolves uniquely, the
 * visitor computes the same FunctionDefinition.id lang-go emits and
 * sets it on the endpoint's `handlerFunctionId` field, so flow walks
 * can BFS through the handler body into DB hops.
 *
 * Unresolved cases (intentional):
 *   - inline function literals (`func(c *gin.Context) {...}`) — lang-go
 *     does not emit FunctionDefinition for anonymous functions
 *   - ambiguous method names (two structs with the same method name) —
 *     left null to avoid arbitrary false positives
 */

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

export function createGinVisitor(handlerMap?: HandlerMap): GoFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();
  // Per-file map of receiver name → composed prefix from `Group(...)`
  // chains. Populated when the source_file root is visited.
  const prefixesByFile = new Map<string, Map<string, string>>();

  return {
    language: 'go',
    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

      // Pre-pass: collect every `:= ... .Group("/x")` binding.
      if (node.type === 'source_file') {
        if (!prefixesByFile.has(fileId)) {
          prefixesByFile.set(fileId, scanFileForGroupPrefixes(node));
        }
        return;
      }

      if (node.type !== 'call_expression') return;

      if (!fileImportsGin(node, ctx.sourceFile.filePath, fileImportCache)) return;

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'selector_expression') return;

      const field = fnNode.childForFieldName('field');
      if (!field) return;
      const methodName = field.text;

      const operand = fnNode.childForFieldName('operand');
      if (!operand) return;
      if (operand.text === 'gin') return; // Skip gin.Default() etc.

      const args = node.childForFieldName('arguments');
      if (!args) return;

      // Receiver is typically a bare identifier; method-chain receivers
      // (`router.Group("/api").GET(...)`) are anonymous and don't get
      // a prefix composed here.
      const receiverName = operand.type === 'identifier' ? operand.text : null;
      const prefix = receiverName
        ? (prefixesByFile.get(fileId)?.get(receiverName) ?? '')
        : '';

      // The route methods take args in the order (path, handler, ...).
      // `Handle` takes (method, path, handler). Resolve the handler
      // arg's position so we can look it up in the project handler map.
      // ── Standard HTTP method routes ────────────────────────────────
      if (HTTP_METHODS.has(methodName)) {
        const pathArg = findFirstStringArg(args);
        if (pathArg === null) {
          recordConfidenceDecision('gin route path is not a string literal', {
            'gin.method': methodName,
            'call.sourceLine': node.startPosition.row + 1,
          });
          return;
        }
        const handlerId = resolveHandlerId(ctx, args, /*handlerArgPosition*/ 1);
        emitEndpoint(ctx, node, methodName, joinPaths(prefix, pathArg), handlerId);
        return;
      }

      // ── router.Any("/path", handler) → ALL (m1 fix) ───────────────
      if (methodName === 'Any') {
        const pathArg = findFirstStringArg(args);
        if (pathArg === null) return;
        const handlerId = resolveHandlerId(ctx, args, 1);
        emitEndpoint(ctx, node, 'ALL', joinPaths(prefix, pathArg), handlerId);
        return;
      }

      // ── router.Handle("METHOD", "/path", handler) (m1 fix) ─────────
      if (methodName === 'Handle') {
        const argValues = extractStringArgs(args, 2);
        if (argValues.length < 2) return;
        const httpMethod = argValues[0].toUpperCase();
        const routePattern = argValues[1];
        const handlerId = resolveHandlerId(ctx, args, 2);
        emitEndpoint(ctx, node, httpMethod, joinPaths(prefix, routePattern), handlerId);
        return;
      }
    },
  };

  /**
   * Pick the Nth named argument from a Gin route call and look its
   * name up in the project-wide handler map. Returns the synthetic
   * FunctionDefinition id lang-go would have minted, or null when:
   *
   *   - no handler map is available (plugin used without onProjectLoaded)
   *   - the arg isn't a bare identifier or `<recv>.<method>` selector
   *   - the looked-up name is ambiguous (multiple matches across files)
   *   - the looked-up name has no matching function declaration
   */
  function resolveHandlerId(
    ctx: GoVisitContext,
    args: SyntaxNode,
    handlerArgPosition: number,
  ): string | null {
    if (!handlerMap) return null;
    const lookupName = pickHandlerLookupName(args, handlerArgPosition);
    if (!lookupName) return null;
    const entry = handlerMap.byName.get(lookupName);
    if (!entry) return null; // either missing or ambiguous (stored as null)
    const sourceFileId = idFor.sourceFile({
      repository: ctx.sourceFile.repository,
      filePath: entry.filePath,
    });
    return idFor.functionDefinition({
      sourceFileId,
      name: entry.name,
      sourceLine: entry.sourceLine,
    });
  }

  function emitEndpoint(
    ctx: GoVisitContext,
    node: SyntaxNode,
    httpMethod: string,
    routePattern: string,
    handlerFunctionId: string | null,
  ): void {
    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: ctx.sourceFile.repository,
        httpMethod,
        routePattern,
        filePath: ctx.sourceFile.filePath,
        lineStart: node.startPosition.row + 1,
      }),
      httpMethod,
      routePattern,
      handlerFunctionId,
      framework: 'gin',
      repository: ctx.sourceFile.repository,
      evidence: {
        filePath: ctx.sourceFile.filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        snippet: node.text.slice(0, 200),
        confidence: 'exact',
      },
    };
    ctx.emitNode(endpoint);
  }
}

/**
 * Walk the call's argument list and pick the named handler from
 * position `handlerArgPosition` (0-based, ignoring leading
 * punctuation children that tree-sitter exposes as siblings). Then
 * extract the *lookup name* for the handler map:
 *
 *   `handleX`                  → 'handleX'   (bare identifier)
 *   `v.List`                   → 'List'      (last selector segment)
 *   `pkg.Handler`              → 'Handler'   (same shape)
 *   `func(c *gin.Context){...}`→ null        (inline anonymous; lang-go
 *                                              doesn't emit a definition)
 *   anything else              → null
 */
function pickHandlerLookupName(args: SyntaxNode, handlerArgPosition: number): string | null {
  // tree-sitter-go exposes `argument_list` children as a mix of
  // commas, parens, and the actual expression nodes. Pick by counting
  // "name-able" expression children.
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (
      child.type === 'argument_list' ||
      child.type === '(' ||
      child.type === ')' ||
      child.type === ','
    ) {
      continue;
    }
    if (seen === handlerArgPosition) {
      return extractCalleeName(child);
    }
    seen++;
  }
  return null;
}

function extractCalleeName(node: SyntaxNode): string | null {
  // Bare identifier — `handleX`
  if (node.type === 'identifier') return node.text;
  // Selector expression — `v.List` / `pkg.Handler`. The `field` child
  // is the last segment.
  if (node.type === 'selector_expression') {
    const field = node.childForFieldName('field');
    return field ? field.text : null;
  }
  // Anything else (function literal, qualified type-conversion, etc.)
  return null;
}

function fileImportsGin(
  node: SyntaxNode,
  filePath: string,
  cache: Map<string, boolean>,
): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;

  const sourceFile = node.tree.rootNode;
  let hasGin = false;
  for (let i = 0; i < sourceFile.childCount; i++) {
    const child = sourceFile.child(i)!;
    if (child.type === 'import_declaration') {
      if (child.text.includes('gin-gonic/gin')) {
        hasGin = true;
        break;
      }
    }
  }

  cache.set(filePath, hasGin);
  return hasGin;
}

/** Extract the first string literal from an argument list. */
export function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal') {
      return child.text.slice(1, -1);
    }
  }
  return null;
}

/** Extract the first N string literal values from an argument list. */
function extractStringArgs(args: SyntaxNode, count: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.childCount && result.length < count; i++) {
    const child = args.child(i)!;
    if (child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal') {
      result.push(child.text.slice(1, -1));
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Group prefix scanning (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk every `<id> := <other>.Group("/x")` and `var <id> =
 * <other>.Group("/x")` binding in the file, then resolve each name's
 * full prefix by following the parent chain.
 *
 * Bindings whose parent has no group prefix (e.g. `gin.Default()` or
 * a function parameter) terminate the chain with an empty prefix —
 * the receiver simply has no inherited group.
 */
function scanFileForGroupPrefixes(rootNode: SyntaxNode): Map<string, string> {
  const raw = new Map<string, { parent: string | null; segment: string }>();

  function walk(node: SyntaxNode): void {
    if (node.type === 'short_var_declaration' || node.type === 'var_spec') {
      collectFromVarDecl(node, raw);
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }
  walk(rootNode);

  const composed = new Map<string, string>();
  for (const [name] of raw) {
    composed.set(name, resolvePrefix(name, raw, new Set<string>()));
  }
  return composed;
}

function collectFromVarDecl(
  node: SyntaxNode,
  out: Map<string, { parent: string | null; segment: string }>
): void {
  // Both short_var_declaration and var_spec expose their LHS / RHS
  // through the `left` / `right` (short var) or `name` / `value`
  // (var_spec) fields. Try both.
  const left = node.childForFieldName('left') ?? node.childForFieldName('name');
  const right = node.childForFieldName('right') ?? node.childForFieldName('value');
  if (!left || !right) return;

  const names: string[] = [];
  if (left.type === 'identifier') {
    names.push(left.text);
  } else {
    for (let i = 0; i < left.childCount; i++) {
      const c = left.child(i)!;
      if (c.type === 'identifier') names.push(c.text);
    }
  }

  const exprs: SyntaxNode[] = [];
  if (right.type === 'call_expression') {
    exprs.push(right);
  } else {
    for (let i = 0; i < right.childCount; i++) {
      const c = right.child(i)!;
      if (c.type === 'call_expression') exprs.push(c);
    }
  }

  for (let i = 0; i < names.length && i < exprs.length; i++) {
    const r = parseGroupCall(exprs[i]);
    if (r) out.set(names[i], r);
  }
}

/**
 * Match `<obj>.Group("/x")`. Returns the parent identifier name and
 * the static segment, or null when the call doesn't fit that shape.
 */
function parseGroupCall(call: SyntaxNode): { parent: string | null; segment: string } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return null;
  const field = fn.childForFieldName('field');
  if (!field || field.text !== 'Group') return null;

  const operand = fn.childForFieldName('operand');
  const parent = operand && operand.type === 'identifier' ? operand.text : null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const segment = findFirstStringArg(args);
  if (segment === null) return null;

  return { parent, segment };
}

/** Resolve a name's full prefix by walking the parent chain. */
function resolvePrefix(
  name: string,
  raw: Map<string, { parent: string | null; segment: string }>,
  visited: Set<string>
): string {
  if (visited.has(name)) return '';
  visited.add(name);
  const entry = raw.get(name);
  if (!entry) return '';
  const parentPrefix = entry.parent ? resolvePrefix(entry.parent, raw, visited) : '';
  return joinPaths(parentPrefix, entry.segment);
}

function joinPaths(prefix: string, suffix: string): string {
  if (prefix === '') return suffix;
  if (suffix === '') return prefix;
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}
