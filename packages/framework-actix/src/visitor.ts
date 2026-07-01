import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import type { RustFrameworkVisitor } from '@adorable/lang-rust';

/**
 * Actix-web framework visitor (#24, #204 prefix composition).
 *
 * Detects endpoints via attribute macros on function items:
 *   #[get("/users/{id}")] async fn get_user(...) -> impl Responder {}
 *   #[post("/users")] async fn create_user(...) -> impl Responder {}
 *
 * Composes web::scope("/...") prefixes (#204):
 *   #[get("/")]
 *   async fn list_users() -> impl Responder { ... }
 *
 *   web::scope("/api")
 *     .service(web::scope("/users").service(list_users))
 *
 *   →  GET /api/users/
 *
 * The visitor pre-scans the file for `web::scope("/p")...service(<id>)`
 * chains (recursing into nested scopes) and builds a `<fn_name> →
 * composed prefix` map. When a function's HTTP attribute fires, the
 * mapped prefix is prepended to the route literal in the attribute.
 *
 * Conservative on purpose:
 *   - Same-file only.
 *   - scope segment must be a string literal.
 *   - `.configure(<fn>)` (deferred-registration via a config function)
 *     and `.cfg.service(...)` are out of scope — explicit follow-up.
 *
 * Supported attributes: get, post, put, delete, patch, head, options.
 * Actix {param} and {param:regex} → normalized to :param.
 *
 * Only matches files importing from `actix_web`.
 *
 * Disambiguation with Rocket: Both use `#[get("/path")]`. They are
 * separated by per-file import checks (`actix_web` vs `rocket`).
 *
 * TODO: Handler resolution — handlerFunctionId is always null.
 */

const ACTIX_HTTP_ATTRS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
]);

export function createActixVisitor(): RustFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();
  // Per-file map of function name → composed scope prefix.
  const prefixesByFile = new Map<string, Map<string, string>>();

  return {
    language: 'rust',
    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

      if (node.type !== 'function_item') return;

      if (!fileImportsActix(node, ctx.sourceFile.filePath, fileImportCache)) return;

      // Lazy pre-pass on first function in this file (lang-rust does
      // not dispatch the source_file root to visitors).
      if (!prefixesByFile.has(fileId)) {
        prefixesByFile.set(fileId, scanFileForScopePrefixes(node.tree.rootNode));
      }

      // M3 fix: Walk backwards through ALL preceding attribute_item siblings
      // to handle stacked attributes like #[cfg(test)] #[get("/path")]
      const result = findHttpAttributeInPrecedingSiblings(node);
      if (!result) return;

      const { method, routePattern, attrNode } = result;

      // Compose prefix from the function's name (Actix attaches the
      // route to the fn's identifier; the name is the lookup key).
      const nameNode = node.childForFieldName('name');
      const fnName = nameNode?.text ?? null;
      const prefix = fnName
        ? (prefixesByFile.get(fileId)?.get(fnName) ?? '')
        : '';
      const composedPath = joinPaths(prefix, routePattern);

      const endpoint: APIEndpoint = {
        nodeType: 'APIEndpoint',
        id: idFor.apiEndpoint({
          repository: ctx.sourceFile.repository,
          httpMethod: method,
          routePattern: composedPath,
          filePath: ctx.sourceFile.filePath,
          lineStart: attrNode.startPosition.row + 1,
        }),
        httpMethod: method,
        routePattern: composedPath,
        handlerFunctionId: null,
        framework: 'actix',
        repository: ctx.sourceFile.repository,
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: attrNode.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          snippet: (attrNode.text + '\n' + node.text).slice(0, 300),
          confidence: 'exact',
        },
      };
      ctx.emitNode(endpoint);
    },
  };
}

/**
 * Walk backwards through preceding attribute_item siblings to find
 * an HTTP method attribute. Handles stacked attributes like:
 *   #[cfg(not(test))]
 *   #[get("/path")]
 *   async fn handler() {}
 */
function findHttpAttributeInPrecedingSiblings(
  fnNode: SyntaxNode
): { method: string; routePattern: string; attrNode: SyntaxNode } | null {
  let current = fnNode.previousNamedSibling;
  while (current && current.type === 'attribute_item') {
    const result = parseHttpAttribute(current);
    if (result) {
      return { ...result, attrNode: current };
    }
    current = current.previousNamedSibling;
  }
  return null;
}

function parseHttpAttribute(attr: SyntaxNode): { method: string; routePattern: string } | null {
  const attrNode = attr.children.find((c) => c.type === 'attribute');
  if (!attrNode) return null;

  const nameNode = attrNode.children.find((c) => c.type === 'identifier');
  if (!nameNode) return null;
  const attrName = nameNode.text;

  if (!ACTIX_HTTP_ATTRS.has(attrName)) return null;

  const tokenTree = attrNode.children.find((c) => c.type === 'token_tree');
  if (!tokenTree) return null;

  const strLit = tokenTree.children.find((c) => c.type === 'string_literal');
  if (!strLit) return null;

  // Strip quotes and normalize {param} and {param:regex} → :param (m4 fix)
  const rawPath = strLit.text.slice(1, -1);
  const routePattern = rawPath.replace(/\{(\w+)(?::[^}]*)?\}/g, ':$1');

  return { method: attrName.toUpperCase(), routePattern };
}

function fileImportsActix(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'use_declaration' && child.text.includes('actix_web')) {
      has = true;
      break;
    }
  }
  cache.set(filePath, has);
  return has;
}

// ──────────────────────────────────────────────────────────────────────
// Scope prefix scanning (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the file for top-level `web::scope("/p").service(...)...` chains,
 * recurse into any nested scopes registered via `.service(web::scope(...))`,
 * and build a `<function name> → composed prefix` map.
 *
 * The same function appearing in two different scopes would be a build
 * error in Actix (the function can only be `.service()`-registered
 * once). On any conflict, last-write-wins — but flagging it as an
 * issue is out of scope here.
 */
function scanFileForScopePrefixes(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();

  // First: collect every `web::scope(...)` call (the chain root). Each
  // scope is processed once, regardless of where in the chain it sits.
  const scopeRoots: SyntaxNode[] = [];
  function collectScopes(node: SyntaxNode): void {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && isWebScopePath(fn)) {
        scopeRoots.push(node);
      }
    }
    for (let i = 0; i < node.childCount; i++) collectScopes(node.child(i)!);
  }
  collectScopes(rootNode);

  // For each scope, find its enclosing scope via ancestor walk and
  // compute its composed prefix recursively. Cache by node.id (number)
  // — tree-sitter web returns fresh JS wrappers per access so a
  // Map<SyntaxNode, ...> would never hit.
  const composedCache = new Map<number, string>();
  function composedPrefixFor(scopeRoot: SyntaxNode): string {
    if (composedCache.has(scopeRoot.id)) return composedCache.get(scopeRoot.id)!;
    const args = scopeRoot.childForFieldName('arguments');
    const segment = args ? findFirstStringArg(args) : null;
    if (segment === null) {
      composedCache.set(scopeRoot.id, '');
      return '';
    }
    const enclosing = findEnclosingScopeRoot(scopeRoot);
    const parentPrefix = enclosing ? composedPrefixFor(enclosing) : '';
    const c = joinPaths(parentPrefix, segment);
    composedCache.set(scopeRoot.id, c);
    return c;
  }

  // Walk each scope's chain (from the root call outward via field_expression
  // parents) collecting `.service(<id>)` calls. For each identifier service,
  // map name → this scope's composed prefix.
  for (const scopeRoot of scopeRoots) {
    const composed = composedPrefixFor(scopeRoot);
    if (composed === '') continue; // segment couldn't be parsed
    walkChainServices(scopeRoot, (svc) => {
      if (svc.type === 'identifier') {
        out.set(svc.text, composed);
      }
      // Nested scope arguments are processed independently when their
      // own scope root is visited above.
    });
  }

  return out;
}

/**
 * Walk OUTWARD from a scope's root call expression through the chain's
 * field_expression links, calling `onService(arg)` for each
 * `.service(<arg>)` call encountered. Stops when the chain ends (the
 * enclosing parent isn't a `field_expression.value` link).
 */
function walkChainServices(scopeRoot: SyntaxNode, onService: (arg: SyntaxNode) => void): void {
  let current: SyntaxNode | null = scopeRoot;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent || parent.type !== 'field_expression') return;
    // Identity via .id — tree-sitter web returns fresh JS wrappers
    // per access (Node refs aren't stable across calls).
    if (parent.childForFieldName('value')?.id !== current.id) return;
    const grand: SyntaxNode | null = parent.parent;
    if (!grand || grand.type !== 'call_expression') return;

    const field = parent.childForFieldName('field');
    if (field?.text === 'service') {
      const args = grand.childForFieldName('arguments');
      if (args) {
        const arg = findFirstNamedArg(args);
        if (arg) onService(arg);
      }
    }
    // Walk to the next call in the chain.
    current = grand;
  }
}

/**
 * Walk ancestors from a scope's root call to find the enclosing
 * `web::scope(...)` call (if any). Stops at function / closure
 * boundaries — a scope can't escape its enclosing function.
 */
function findEnclosingScopeRoot(scopeRoot: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = scopeRoot.parent;
  while (current) {
    if (current.type === 'function_item' || current.type === 'closure_expression') {
      return null;
    }
    if (current.type === 'call_expression') {
      // If this call's chain root is web::scope (and not the SAME
      // scope we started from — tree-sitter web returns fresh JS
      // wrappers per access, so identity uses node.id), that's the
      // enclosing scope's chain root.
      const root = findChainRoot(current);
      if (root && root.id !== scopeRoot.id && root.type === 'call_expression') {
        const fn = root.childForFieldName('function');
        if (fn && isWebScopePath(fn)) return root;
      }
    }
    current = current.parent;
  }
  return null;
}

/** Walk inward through `field_expression.value` until we hit a non-chain root. */
function findChainRoot(call: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) return current;
    if (fn.type !== 'field_expression') return current;
    const inner = fn.childForFieldName('value');
    if (!inner || inner.type !== 'call_expression') return current;
    current = inner;
  }
  return current;
}

/** Match `web::scope` or `scope` (when imported directly). */
function isWebScopePath(fn: SyntaxNode): boolean {
  if (fn.type === 'identifier') return fn.text === 'scope';
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    return name?.text === 'scope';
  }
  return false;
}

/**
 * Walk a scope chain from outer to inner, collecting `.service(...)`
 * arguments. Each service argument is either:
 *   - an identifier → maps directly to the chain's prefix
 *   - a nested `web::scope(...)` chain → recurse with the composed
 *     prefix as the parent
 */
function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (
      child.type === 'string_literal' ||
      child.type === 'interpreted_string_literal' ||
      child.type === 'raw_string_literal'
    ) {
      return stripStringQuotes(child.text);
    }
  }
  return null;
}

function findFirstNamedArg(args: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    if (!child.isNamed) continue;
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    return child;
  }
  return null;
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
