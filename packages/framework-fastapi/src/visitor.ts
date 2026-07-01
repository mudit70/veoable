import { idFor, type APIEndpoint } from '@adorable/schema';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;

/**
 * FastAPI framework visitor (#42, #204 prefix composition).
 *
 * Detects API endpoints declared via FastAPI decorators:
 *   @app.get("/api/tasks")
 *   @app.post("/api/tasks", status_code=201)
 *   @router.delete("/api/tasks/{task_id}")
 *
 * Composes prefixes from the route's receiver (#204):
 *   router = APIRouter(prefix="/users")
 *   @router.get("/{id}")                             →  /users/:id
 *
 *   app.include_router(router, prefix="/api")
 *   # any route on `router` now gets composed:       →  /api/users/:id
 *
 * Prefix sources, in order of composition:
 *   include_prefix (from `app.include_router(router, prefix=...)`)
 *   + router_prefix (from `router = APIRouter(prefix=...)`)
 *   + method_path (from `@router.get("/path")`)
 *
 * Composition is conservative — only handled when both sides are
 * statically resolvable and live in the same file. Cross-file
 * resolution and multi-level `include_router` chains beyond depth 1
 * are explicit non-goals here (separate follow-ups).
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

import type { IncludeRouterMap } from './include-resolver.js';

export function createFastapiVisitor(includeMap?: IncludeRouterMap): PyFrameworkVisitor {
  // Per-file map of receiver name → composed prefix.
  // Populated when the module root node is visited; consumed when
  // each decorator fires.
  const prefixesByFile = new Map<string, Map<string, string>>();
  const crossFilePrefix = includeMap?.composedPrefixByRouterId ?? new Map<string, string>();

  return {
    language: 'py',

    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

      // Pre-pass: when the module root fires, scan top-level children
      // for `<id> = APIRouter(prefix="...")` and
      // `<obj>.include_router(<id>, prefix="...")` calls. The decorator
      // pass below uses the resulting map.
      if (node.type === 'module') {
        if (!prefixesByFile.has(fileId)) {
          prefixesByFile.set(fileId, scanModuleForPrefixes(node));
        }
        return;
      }

      if (node.type !== 'decorated_definition') return;

      const decorators = node.children.filter((c) => c.type === 'decorator');
      const fnDef = node.childForFieldName('definition');
      if (!fnDef || fnDef.type !== 'function_definition') return;

      const prefixMap = prefixesByFile.get(fileId) ?? new Map<string, string>();

      for (const decorator of decorators) {
        const result = parseHttpDecorator(decorator);
        if (!result) continue;

        const nameNode = fnDef.childForFieldName('name');
        const fnName = nameNode?.text ?? 'handler';
        const line = fnDef.startPosition.row + 1;

        const handlerFnId = idFor.functionDefinition({
          sourceFileId: ctx.sourceFile.id,
          name: fnName,
          sourceLine: line,
        });

        // Compose prefix from the receiver (e.g. `router` in
        // `@router.get(...)`) when it has a known prefix binding.
        // The cross-file resolver wins when present — it carries the
        // include_router(prefix=…) chain that this file's own scan
        // can't see. Otherwise fall back to the per-file map.
        const composedPrefix =
          crossFilePrefix.get(result.receiver) ??
          prefixMap.get(result.receiver) ??
          '';
        const composedPath = joinPaths(composedPrefix, result.path);

        // Convert Python path params {task_id} to Express-style :task_id
        const routePattern = composedPath.replace(/\{(\w+)\}/g, ':$1');

        const endpoint: APIEndpoint = {
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({
            repository: ctx.sourceFile.repository,
            httpMethod: result.method,
            routePattern,
            filePath: ctx.sourceFile.filePath,
            lineStart: line,
          }),
          httpMethod: result.method,
          routePattern,
          handlerFunctionId: handlerFnId,
          framework: 'fastapi',
          repository: ctx.sourceFile.repository,
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

interface HttpDecoratorResult {
  method: string;
  path: string;
  /**
   * Receiver name in the decorator call — e.g., `router` in
   * `@router.get("/{id}")`. Used to look up an associated prefix
   * established at module scope.
   */
  receiver: string;
}

function parseHttpDecorator(decorator: SyntaxNode): HttpDecoratorResult | null {
  for (const child of decorator.children) {
    if (child.type === 'call') {
      return parseDecoratorCall(child);
    }
  }
  return null;
}

function parseDecoratorCall(call: SyntaxNode): HttpDecoratorResult | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;

  const obj = fn.childForFieldName('object');
  const attr = fn.childForFieldName('attribute');
  if (!attr || !obj) return null;

  const methodName = attr.text.toLowerCase();
  if (!HTTP_METHODS.has(methodName)) return null;

  // Receiver name (`router` in `@router.get`). Bare identifier only
  // — `@some.nested.router.get` is rare and skipped here.
  if (obj.type !== 'identifier') return null;
  const receiver = obj.text;

  // Extract the route path from the first positional string argument.
  const args = call.childForFieldName('arguments');
  if (!args) return null;

  let routePath: string | null = null;
  for (const arg of args.children) {
    if (arg.type === 'string' || arg.type === 'concatenated_string') {
      routePath = stripStringQuotes(arg.text);
      break;
    }
  }

  if (routePath === null) return null;

  return {
    method: methodName.toUpperCase(),
    path: routePath,
    receiver,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Module-level prefix scanning (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Scan a Python module's top-level children for FastAPI router prefix
 * bindings. Returns a map `<receiver name> → <composed prefix>`.
 *
 * Two shapes contribute:
 *   1. `router = APIRouter(prefix="/x")`           → router_prefix = '/x'
 *   2. `app.include_router(router, prefix="/api")` → include_prefix = '/api'
 *
 * Final mapping for a router is `include_prefix + router_prefix`. When
 * `include_router` is called multiple times on the same router (rare),
 * the LAST call wins — there's no good way to disambiguate which
 * mounting a single decorator emits to without dataflow analysis.
 */
function scanModuleForPrefixes(moduleNode: SyntaxNode): Map<string, string> {
  // First pass: collect router_prefix bindings from APIRouter() calls.
  const routerPrefix = new Map<string, string>();
  // Second pass: include_router additions.
  const includePrefix = new Map<string, string>();

  for (const child of moduleNode.children) {
    // Direct assignment: `router = APIRouter(prefix="/x")`.
    if (child.type === 'expression_statement') {
      const inner = child.children[0];
      if (inner && inner.type === 'assignment') {
        const result = parseAPIRouterAssignment(inner);
        if (result) {
          routerPrefix.set(result.name, result.prefix);
          continue;
        }
        const inc = parseIncludeRouterCallFromAssignment(inner);
        if (inc) {
          includePrefix.set(inc.routerName, inc.prefix);
          continue;
        }
      }
      // Bare `app.include_router(router, prefix="/api")` statement.
      if (inner && inner.type === 'call') {
        const inc = parseIncludeRouterCall(inner);
        if (inc) {
          includePrefix.set(inc.routerName, inc.prefix);
        }
      }
    }
  }

  // Compose: final = include + router_prefix.
  const composed = new Map<string, string>();
  const allNames = new Set<string>([...routerPrefix.keys(), ...includePrefix.keys()]);
  for (const name of allNames) {
    const inc = includePrefix.get(name) ?? '';
    const rp = routerPrefix.get(name) ?? '';
    const c = joinPaths(inc, rp);
    if (c !== '') composed.set(name, c);
  }
  return composed;
}

/**
 * Recognize `<id> = APIRouter(prefix="/x", ...)` and return
 * `{ name: <id>, prefix: "/x" }`. Returns null when the assignment
 * doesn't bind an APIRouter or has no static prefix.
 */
function parseAPIRouterAssignment(assignment: SyntaxNode): { name: string; prefix: string } | null {
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  if (!left || !right) return null;
  if (left.type !== 'identifier') return null;
  if (right.type !== 'call') return null;

  const callTarget = right.childForFieldName('function');
  if (!callTarget) return null;
  // Accept `APIRouter(...)` or `fastapi.APIRouter(...)`.
  let calleeName: string | null = null;
  if (callTarget.type === 'identifier') {
    calleeName = callTarget.text;
  } else if (callTarget.type === 'attribute') {
    const a = callTarget.childForFieldName('attribute');
    calleeName = a?.text ?? null;
  }
  if (calleeName !== 'APIRouter') return null;

  const args = right.childForFieldName('arguments');
  if (!args) return null;
  const prefix = findKwargString(args, 'prefix');
  if (prefix === null) return null;

  return { name: left.text, prefix };
}

/**
 * Recognize `<obj>.include_router(<router_id>, prefix="/x", ...)` —
 * either as a bare statement or as the right side of an assignment
 * (rare but valid). Returns the router id and prefix.
 */
function parseIncludeRouterCall(call: SyntaxNode): { routerName: string; prefix: string } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;
  const attr = fn.childForFieldName('attribute');
  if (!attr || attr.text !== 'include_router') return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;

  // First positional arg is the router identifier.
  let routerName: string | null = null;
  for (const a of args.children) {
    if (a.type === 'identifier') {
      routerName = a.text;
      break;
    }
  }
  if (!routerName) return null;

  const prefix = findKwargString(args, 'prefix') ?? '';
  return { routerName, prefix };
}

function parseIncludeRouterCallFromAssignment(
  assignment: SyntaxNode
): { routerName: string; prefix: string } | null {
  const right = assignment.childForFieldName('right');
  if (!right || right.type !== 'call') return null;
  return parseIncludeRouterCall(right);
}

/**
 * Look up a keyword argument by name in a Python `argument_list` node
 * and return its string-literal value, or null when absent / non-literal.
 */
function findKwargString(args: SyntaxNode, key: string): string | null {
  for (const child of args.children) {
    if (child.type !== 'keyword_argument') continue;
    const name = child.childForFieldName('name');
    if (!name || name.text !== key) continue;
    const value = child.childForFieldName('value');
    if (!value) return null;
    if (value.type === 'string' || value.type === 'concatenated_string') {
      return stripStringQuotes(value.text);
    }
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// String / path utilities
// ──────────────────────────────────────────────────────────────────────

/**
 * Strip Python string-literal quotes. Handles single, double, and
 * triple-quoted forms but not f-strings or byte literals — those
 * shapes don't appear in static prefixes.
 */
function stripStringQuotes(text: string): string {
  let s = text;
  // Remove leading r/R/b/B/u/U prefix (rare in route literals).
  if (/^[rRbBuU]+/.test(s)) s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

/**
 * Join two URL fragments without producing duplicate or missing slashes.
 *
 *   joinPaths('/api', '/users')   →  '/api/users'
 *   joinPaths('/api/', '/users')  →  '/api/users'
 *   joinPaths('/api/', 'users')   →  '/api/users'
 *   joinPaths('', '/users')       →  '/users'
 *   joinPaths('/api', '')         →  '/api'
 */
function joinPaths(prefix: string, suffix: string): string {
  if (prefix === '') return suffix;
  if (suffix === '') return prefix;
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}
