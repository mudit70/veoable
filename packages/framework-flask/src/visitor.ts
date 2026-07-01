import { idFor, type APIEndpoint } from '@adorable/schema';
import type { PyFrameworkVisitor } from '@adorable/lang-py';
import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;

/**
 * Flask framework visitor (#20, #204 prefix composition).
 *
 * Detects Flask route decorators:
 *   @app.route("/users", methods=["GET", "POST"])
 *   @app.get("/users")
 *   @app.post("/users")
 *   @blueprint.route("/users/<int:user_id>")
 *
 * Composes blueprint prefixes (#204):
 *   bp = Blueprint('users', __name__, url_prefix='/users')
 *   @bp.route("/<int:id>")                                  →  /users/:id
 *
 *   app.register_blueprint(bp, url_prefix='/api')
 *   # any route on `bp` now gets composed:                  →  /api/users/:id
 *
 * Composition mirrors framework-fastapi's emit-time approach: a
 * pre-pass over the module root collects `Blueprint(...)` constructions
 * and `register_blueprint(...)` calls, building a `receiver name →
 * composed prefix` map consumed when each decorator fires.
 *
 * Conservative on purpose:
 *   - Same-file only (cross-file is a documented non-goal).
 *   - Single-level register_blueprint only.
 *   - Bails on non-string-literal url_prefix values.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

export function createFlaskVisitor(): PyFrameworkVisitor {
  // Per-file map of receiver name → composed url_prefix.
  const prefixesByFile = new Map<string, Map<string, string>>();

  return {
    language: 'py',

    onNode(ctx, node) {
      const fileId = ctx.sourceFile.id;

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
        const results = parseFlaskDecorator(decorator);
        if (!results || results.length === 0) continue;

        const nameNode = fnDef.childForFieldName('name');
        const fnName = nameNode?.text ?? 'handler';
        const line = fnDef.startPosition.row + 1;

        for (const result of results) {
          const handlerFnId = idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name: fnName,
            sourceLine: line,
          });

          // Compose prefix from the decorator's receiver (`bp` in
          // `@bp.route(...)`) when known.
          const composedPrefix = prefixMap.get(result.receiver) ?? '';
          const composedPath = joinPaths(composedPrefix, result.path);

          // Convert Flask path params <type:name> or <name> to :name
          const routePattern = composedPath.replace(/<(?:\w+:)?(\w+)>/g, ':$1');

          const endpoint: APIEndpoint = {
            nodeType: 'APIEndpoint',
            id: idFor.apiEndpoint({
              repository: ctx.sourceFile.repository,
              httpMethod: result.method,
              routePattern,
              filePath: ctx.sourceFile.filePath,
              lineStart: fnDef.startPosition.row + 1,
            }),
            httpMethod: result.method,
            routePattern,
            handlerFunctionId: handlerFnId,
            framework: 'flask',
            repository: ctx.sourceFile.repository,
            evidence: {
              filePath: ctx.sourceFile.filePath,
              lineStart: fnDef.startPosition.row + 1,
              lineEnd: fnDef.endPosition.row + 1,
              snippet: fnDef.text.slice(0, 200),
              confidence: 'exact' as const,
            },
          };
          ctx.emitNode(endpoint);
        }
      }
    },
  };
}

interface FlaskRoute {
  method: string;
  path: string;
  /** Receiver name (`app` or `bp` etc.) for prefix lookup. */
  receiver: string;
}

function parseFlaskDecorator(decorator: SyntaxNode): FlaskRoute[] | null {
  for (const child of decorator.children) {
    if (child.type !== 'call') continue;

    const fn = child.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') return null;

    const obj = fn.childForFieldName('object');
    if (!obj || obj.type !== 'identifier') return null;
    const receiver = obj.text;

    const attr = fn.childForFieldName('attribute')?.text;
    if (!attr) return null;

    const args = child.childForFieldName('arguments');
    if (!args) return null;

    // @app.get("/path"), @app.post("/path") — single method
    if (HTTP_METHODS.has(attr)) {
      const routePath = extractStringArg(args);
      if (routePath === null) return null;
      return [{ method: attr.toUpperCase(), path: routePath, receiver }];
    }

    // @app.route("/path", methods=["GET", "POST"])
    if (attr === 'route') {
      const routePath = extractStringArg(args);
      if (routePath === null) return null;

      const methods = extractMethodsList(args);
      if (methods.length > 0) {
        return methods.map((m) => ({ method: m, path: routePath, receiver }));
      }
      // Default: GET only
      return [{ method: 'GET', path: routePath, receiver }];
    }
  }
  return null;
}

function extractStringArg(args: SyntaxNode): string | null {
  for (const child of args.children) {
    if (child.type === 'string' || child.type === 'concatenated_string') {
      return stripStringQuotes(child.text);
    }
  }
  return null;
}

function extractMethodsList(args: SyntaxNode): string[] {
  for (const child of args.children) {
    if (child.type === 'keyword_argument') {
      const key = child.childForFieldName('name')?.text;
      if (key === 'methods') {
        const value = child.childForFieldName('value');
        if (value?.type === 'list') {
          return value.children
            .filter((c) => c.type === 'string')
            .map((c) => c.text.replace(/['"]/g, '').toUpperCase());
        }
      }
    }
  }
  return [];
}

// ──────────────────────────────────────────────────────────────────────
// Module-level prefix scanning (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Scan a Python module's top-level children for Flask blueprint prefix
 * bindings. Returns a map `<receiver name> → <composed prefix>`.
 *
 * Two shapes contribute:
 *   1. `bp = Blueprint('name', __name__, url_prefix='/x')`     → blueprint_prefix = '/x'
 *   2. `app.register_blueprint(bp, url_prefix='/api')`         → register_prefix = '/api'
 *
 * Final mapping: `register_prefix + blueprint_prefix`.
 */
function scanModuleForPrefixes(moduleNode: SyntaxNode): Map<string, string> {
  const blueprintPrefix = new Map<string, string>();
  const registerPrefix = new Map<string, string>();

  for (const child of moduleNode.children) {
    if (child.type !== 'expression_statement') continue;
    const inner = child.children[0];
    if (!inner) continue;

    if (inner.type === 'assignment') {
      const bp = parseBlueprintAssignment(inner);
      if (bp) {
        blueprintPrefix.set(bp.name, bp.prefix);
        continue;
      }
    }
    if (inner.type === 'call') {
      const reg = parseRegisterBlueprintCall(inner);
      if (reg) registerPrefix.set(reg.bpName, reg.prefix);
    }
  }

  const composed = new Map<string, string>();
  const allNames = new Set<string>([...blueprintPrefix.keys(), ...registerPrefix.keys()]);
  for (const name of allNames) {
    const r = registerPrefix.get(name) ?? '';
    const b = blueprintPrefix.get(name) ?? '';
    const c = joinPaths(r, b);
    if (c !== '') composed.set(name, c);
  }
  return composed;
}

/**
 * Recognize `<id> = Blueprint(<name>, __name__, url_prefix='/x', ...)`.
 * Returns `{ name: <id>, prefix: '/x' }` or null when the assignment
 * doesn't bind a Blueprint or has no static url_prefix.
 */
function parseBlueprintAssignment(assignment: SyntaxNode): { name: string; prefix: string } | null {
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  if (!left || !right) return null;
  if (left.type !== 'identifier') return null;
  if (right.type !== 'call') return null;

  const callee = right.childForFieldName('function');
  if (!callee) return null;
  let calleeName: string | null = null;
  if (callee.type === 'identifier') {
    calleeName = callee.text;
  } else if (callee.type === 'attribute') {
    calleeName = callee.childForFieldName('attribute')?.text ?? null;
  }
  if (calleeName !== 'Blueprint') return null;

  const args = right.childForFieldName('arguments');
  if (!args) return null;
  const prefix = findKwargString(args, 'url_prefix');
  if (prefix === null) return null;

  return { name: left.text, prefix };
}

/**
 * Recognize `<obj>.register_blueprint(<bp>, url_prefix='/x', ...)`.
 */
function parseRegisterBlueprintCall(call: SyntaxNode): { bpName: string; prefix: string } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;
  const attr = fn.childForFieldName('attribute');
  if (!attr || attr.text !== 'register_blueprint') return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;

  let bpName: string | null = null;
  for (const a of args.children) {
    if (a.type === 'identifier') {
      bpName = a.text;
      break;
    }
  }
  if (!bpName) return null;

  const prefix = findKwargString(args, 'url_prefix') ?? '';
  return { bpName, prefix };
}

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

function stripStringQuotes(text: string): string {
  let s = text;
  if (/^[rRbBuU]+/.test(s)) s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

function joinPaths(prefix: string, suffix: string): string {
  if (prefix === '') return suffix;
  if (suffix === '') return prefix;
  const p = prefix.replace(/\/+$/, '');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}
