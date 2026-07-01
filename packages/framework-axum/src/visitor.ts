import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import { hasCrateImport, type RustFrameworkVisitor } from '@adorable/lang-rust';
import type { HandlerMap } from './handler-resolver.js';

/**
 * Axum framework visitor (#25, #204 prefix composition).
 *
 * Detects endpoints from Axum's builder-pattern routing:
 *   Router::new().route("/path", get(handler))
 *   Router::new().route("/path", get(list).post(create).delete(remove))
 *
 * Composes nest("/...", subrouter) prefixes (#204):
 *   let api = Router::new()
 *       .route("/users", get(list_users))
 *       .route("/users/:id", get(get_user));
 *   let app = Router::new()
 *       .nest("/api", api)
 *       .route("/health", get(health));
 *
 *   →  routes registered on `api` get composed:
 *      GET /api/users
 *      GET /api/users/:id
 *      GET /health  (registered directly on `app`, unchanged)
 *
 * Approach: pre-scan the file for `.nest("/p", <id>)` calls and the
 * enclosing `let <other> = ...` binding (the outer router that owns
 * the nest). Resolve each name's full prefix transitively. When a
 * `.route(...)` call fires, walk up to its enclosing `let <id>` and
 * look up `<id>`'s composed prefix.
 *
 * Conservative on purpose:
 *   - Same-file only.
 *   - nest segment must be a string literal.
 *   - Routes registered on an anonymous `Router::new()` chain (no
 *     `let` binding) get no nest prefix — there's no name to look up.
 *
 * Path strings pass through as-is. Axum currently uses `:param`
 * syntax which matches our normalized format. If Axum migrates to
 * `{param}` syntax in the future, normalization would be needed here.
 *
 * Only matches files importing from `axum`.
 *
 * Handler resolution: when a `handlerMap` is supplied by the
 * plugin's project-load pass, the visitor extracts the handler arg
 * from each `get(handler)` / `post(handler)` / … sub-call and looks
 * it up in the project-wide name map. When the name resolves
 * uniquely, the visitor computes the same FunctionDefinition.id
 * lang-rust emits and sets it on the endpoint's `handlerFunctionId`
 * field, so flow walks can BFS through the handler body into DB
 * hops.
 *
 * Unresolved cases (intentional):
 *   - inline closures (`get(|| async { "ok" })`) — lang-rust does
 *     not emit FunctionDefinition for anonymous closures
 *   - ambiguous fn names (two crates with the same fn name) — left
 *     null to avoid arbitrary false positives
 *   - impl-method handlers — see resolver doc-comment
 */

const AXUM_HTTP_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
]);

export function createAxumVisitor(handlerMap?: HandlerMap): RustFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();
  // Per-file map of router-owner name → composed nest prefix.
  const prefixesByFile = new Map<string, Map<string, string>>();

  return {
    language: 'rust',
    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

      if (node.type !== 'call_expression') return;

      if (!fileImportsAxum(node, ctx.sourceFile.filePath, fileImportCache)) return;

      // Lazy pre-pass: lang-rust's traversal doesn't dispatch the
      // source_file root to visitors, so we build the per-file prefix
      // map the first time a call_expression in this file fires.
      if (!prefixesByFile.has(fileId)) {
        prefixesByFile.set(fileId, scanFileForNestPrefixes(node.tree.rootNode));
      }

      const fnNode = node.childForFieldName('function');
      if (!fnNode || fnNode.type !== 'field_expression') return;

      const field = fnNode.childForFieldName('field');
      if (!field || field.text !== 'route') return;

      const args = node.childForFieldName('arguments');
      if (!args) return;

      const pathStr = findFirstStringArg(args);
      if (pathStr === null) return;

      const methodRouterArg = findSecondNamedArg(args);
      if (!methodRouterArg) return;

      const methodRouters = extractAxumMethodRouters(methodRouterArg);
      if (methodRouters.length === 0) return;

      // Compose prefix from the chain's enclosing `let <id>` binding.
      const ownerName = findEnclosingLetName(node);
      const prefix = ownerName
        ? (prefixesByFile.get(fileId)?.get(ownerName) ?? '')
        : '';
      const composedPath = joinPaths(prefix, pathStr);

      for (const { method, handler } of methodRouters) {
        const handlerFunctionId = handler
          ? resolveHandlerId(ctx, handler)
          : null;
        const endpoint: APIEndpoint = {
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({
            repository: ctx.sourceFile.repository,
            httpMethod: method,
            routePattern: composedPath,
            filePath: ctx.sourceFile.filePath,
            lineStart: node.startPosition.row + 1,
          }),
          httpMethod: method,
          routePattern: composedPath,
          handlerFunctionId,
          framework: 'axum',
          repository: ctx.sourceFile.repository,
          evidence: {
            filePath: ctx.sourceFile.filePath,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            snippet: node.text.slice(0, 300),
            confidence: 'exact',
          },
        };
        ctx.emitNode(endpoint);
      }
    },
  };

  /**
   * Pick a lookup name out of the handler arg of a `get(...)` /
   * `post(...)` / etc. method-router call. Returns the synthetic
   * FunctionDefinition id lang-rust would have minted when the
   * lookup is unique, otherwise null.
   *
   * Handles these arg shapes:
   *   `handler_fn`            → 'handler_fn'    (identifier)
   *   `orders::list`          → 'list'          (scoped path; last segment)
   *   `state.list`            → 'list'          (field expression)
   *   `|| async { ... }`      → null            (closure; lang-rust emits no fn)
   *   anything else           → null
   */
  function resolveHandlerId(
    ctx: { sourceFile: { repository: string } },
    handler: SyntaxNode,
  ): string | null {
    if (!handlerMap) return null;
    const lookupName = extractHandlerLookupName(handler);
    if (!lookupName) return null;
    const entry = handlerMap.byName.get(lookupName);
    if (!entry) return null; // missing OR ambiguous (stored as null)
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
}

function extractHandlerLookupName(node: SyntaxNode): string | null {
  // Bare identifier — `handler_fn`
  if (node.type === 'identifier') return node.text;
  // Scoped path — `orders::list` / `crate::orders::list`. tree-sitter
  // exposes this as `scoped_identifier` with a `name` field.
  if (node.type === 'scoped_identifier') {
    const name = node.childForFieldName('name');
    return name?.text ?? null;
  }
  // Field expression — `state.list`. The `field` child is the last
  // segment.
  if (node.type === 'field_expression') {
    const field = node.childForFieldName('field');
    return field?.text ?? null;
  }
  // Closures and anything else: not resolvable.
  return null;
}

/**
 * Extract HTTP methods AND their corresponding handler arg nodes
 * from an Axum method-router expression.
 *
 *   `get(handler)` → [{ method: "GET", handler: <handler node> }]
 *   `get(list).post(create)` →
 *     [ { method: "GET",  handler: <list node>   },
 *       { method: "POST", handler: <create node> } ]
 *   `get(|| async {...})` → [{ method: "GET", handler: <closure node> }]
 *
 * The handler node is whatever expression sits as the first argument
 * to the HTTP-method function — caller is expected to pattern-match
 * it (closures are unresolvable; identifiers / scoped paths /
 * field-expressions resolve via name lookup).
 */
function extractAxumMethodRouters(node: SyntaxNode): Array<{ method: string; handler: SyntaxNode | null }> {
  const out: Array<{ method: string; handler: SyntaxNode | null }> = [];

  function walk(n: SyntaxNode): void {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier' && AXUM_HTTP_METHODS.has(fn.text)) {
          out.push({ method: fn.text.toUpperCase(), handler: firstArgExpr(n) });
        }
        if (fn.type === 'field_expression') {
          const field = fn.childForFieldName('field');
          if (field && AXUM_HTTP_METHODS.has(field.text)) {
            out.push({ method: field.text.toUpperCase(), handler: firstArgExpr(n) });
          }
          const value = fn.childForFieldName('value');
          if (value) walk(value);
        }
      }
    }
  }

  walk(node);
  return out;
}

/**
 * Return the first non-punctuation, non-comment child of a call's
 * `arguments` block — the handler expression for `get(...)`.
 */
function firstArgExpr(call: SyntaxNode): SyntaxNode | null {
  const args = call.childForFieldName('arguments');
  if (!args) return null;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (!child.isNamed) continue;
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    return child;
  }
  return null;
}

function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal' || child.type === 'string_literal') {
      return stripStringQuotes(child.text);
    }
  }
  return null;
}

/** m1 fix: Only count named, non-punctuation children as arguments. */
function findSecondNamedArg(args: SyntaxNode): SyntaxNode | null {
  let count = 0;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (!child.isNamed) continue;
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    count++;
    if (count === 2) return child;
  }
  return null;
}

/**
 * Per-file "does this file import axum at all?" check. Thin wrapper
 * around lang-rust's `hasCrateImport` so framework-axum doesn't keep
 * its own copy of the use_declaration walk. Extracted in #444 once
 * framework-diesel and framework-tonic each needed the same pattern.
 */
function fileImportsAxum(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const has = hasCrateImport(node.tree.rootNode, 'axum');
  cache.set(filePath, has);
  return has;
}

// ──────────────────────────────────────────────────────────────────────
// Nest prefix scanning (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the file for `.nest("/p", <id>)` calls and, for each, find the
 * `let <other> = ...` binding that contains the call. Build a per-name
 * parent chain, then resolve each name's full prefix transitively.
 *
 *   let api = Router::new().route("/users", get(list));
 *   let app = Router::new().nest("/api", api);
 *
 *   raw:      { api: { parent: "app", segment: "/api" } }
 *   composed: { api: "/api" }   (app has no nest entry → terminates)
 *
 * Multi-level nesting composes through the parent chain. First-defined
 * wins on collision (multiple nest sites for the same router are rare
 * and ambiguous).
 */
function scanFileForNestPrefixes(rootNode: SyntaxNode): Map<string, string> {
  const raw = new Map<string, { parent: string | null; segment: string }>();

  function walk(node: SyntaxNode): void {
    if (node.type === 'call_expression') {
      const r = parseNestCall(node);
      if (r) {
        const parent = findEnclosingLetName(node);
        if (!raw.has(r.nestedName)) {
          raw.set(r.nestedName, { parent, segment: r.segment });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(rootNode);

  const composed = new Map<string, string>();
  for (const [name] of raw) {
    composed.set(name, resolvePrefix(name, raw, new Set<string>()));
  }
  return composed;
}

/**
 * Match `<chain>.nest("/p", <id>)`. Returns `<id>` and `/p`.
 */
function parseNestCall(call: SyntaxNode): { nestedName: string; segment: string } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'field_expression') return null;
  const field = fn.childForFieldName('field');
  if (!field || field.text !== 'nest') return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;

  const segment = findFirstStringArg(args);
  if (segment === null) return null;

  let count = 0;
  let nestedName: string | null = null;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (!child.isNamed) continue;
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    count++;
    if (count === 2 && child.type === 'identifier') {
      nestedName = child.text;
    }
  }
  if (!nestedName) return null;

  return { nestedName, segment };
}

/**
 * Walk up from a node to find the enclosing `let_declaration` and
 * return its bound identifier name. Stops at function / closure
 * boundaries so the chain doesn't escape the enclosing scope.
 */
function findEnclosingLetName(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'let_declaration') {
      const pattern = current.childForFieldName('pattern');
      if (pattern && pattern.type === 'identifier') return pattern.text;
      return null;
    }
    if (current.type === 'function_item' || current.type === 'closure_expression') {
      return null;
    }
    current = current.parent;
  }
  return null;
}

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

function stripStringQuotes(text: string): string {
  if (text.startsWith('r#"') && text.endsWith('"#')) return text.slice(3, -2);
  if (text.startsWith('r"') && text.endsWith('"')) return text.slice(2, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function joinPaths(prefix: string, suffix: string): string {
  if (prefix === '') return suffix;
  if (suffix === '') return prefix;
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}
