import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint, type DatabaseInteraction } from '@veoable/schema';
import type { PhpFrameworkVisitor, PhpVisitContext } from '@veoable/lang-php';

/**
 * Laravel framework visitor (#45, #55).
 *
 * Detects two things:
 *
 * 1. **Route declarations** via Laravel Route facade:
 *    Route::get('/users', [UserController::class, 'index']);
 *    Route::post('/users', [UserController::class, 'store']);
 *
 * 2. **Eloquent database interactions**:
 *    User::all()                → read
 *    User::find($id)            → read
 *    User::create([...])        → write
 *    $user->update([...])       → write
 *    User::destroy($id)         → delete
 *    User::where(...)->get()    → read
 */

// Route detection
const ROUTE_METHODS: Record<string, string> = {
  'get': 'GET',
  'post': 'POST',
  'put': 'PUT',
  'delete': 'DELETE',
  'patch': 'PATCH',
  'options': 'OPTIONS',
  'any': 'ALL',
};

// Eloquent detection
const ELOQUENT_READ: ReadonlySet<string> = new Set([
  'all', 'find', 'findOrFail', 'findMany', 'first', 'firstOrFail',
  'get', 'pluck', 'count', 'exists', 'max', 'min', 'avg', 'sum',
  'paginate', 'simplePaginate', 'cursor', 'lazy', 'chunk',
]);

const ELOQUENT_WRITE: ReadonlySet<string> = new Set([
  'create', 'insert', 'insertOrIgnore', 'save', 'update',
  'updateOrCreate', 'firstOrCreate', 'upsert', 'increment', 'decrement',
  'push', 'fill', 'forceCreate',
]);

const ELOQUENT_DELETE: ReadonlySet<string> = new Set([
  'delete', 'destroy', 'forceDelete', 'truncate',
]);

export function createLaravelVisitor(): PhpFrameworkVisitor {
  return {
    language: 'php',
    onNode(ctx, node) {
      // ── Scoped calls: Route::get() and User::all() ─────────────────
      if (node.type === 'scoped_call_expression') {
        detectRouteCall(ctx, node);
        detectEloquentStaticCall(ctx, node);
        return;
      }

      // ── Member calls: $user->update([...]), $user->delete() ────────
      if (node.type === 'member_call_expression') {
        detectEloquentMemberCall(ctx, node);
        return;
      }
    },
  };
}

function detectRouteCall(ctx: PhpVisitContext, node: SyntaxNode): void {
  const scopeNode = node.childForFieldName('scope');
  const nameNode = node.childForFieldName('name');
  if (!scopeNode || !nameNode) return;

  if (scopeNode.text !== 'Route') return;

  const methodName = nameNode.text;
  const httpMethod = ROUTE_METHODS[methodName];
  if (!httpMethod) return;

  const args = node.childForFieldName('arguments');
  if (!args) return;

  // First argument is the route path
  const pathStr = findFirstStringArg(args);
  if (!pathStr) return;

  // #204: Compose any enclosing Route::group(['prefix' => '...'],
  // function () { ... }) chain. Walks ancestors lexically and
  // concatenates each group's prefix in outer-to-inner order.
  const enclosingPrefix = composeEnclosingGroupPrefix(node);
  const composedPath = joinPaths(enclosingPrefix, pathStr);

  // Normalize {param} → :param
  const routePattern = composedPath.replace(/\{(\w+)\??\}/g, ':$1');

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
    handlerFunctionId: null,
    framework: 'laravel',
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

function detectEloquentStaticCall(ctx: PhpVisitContext, node: SyntaxNode): void {
  if (!ctx.enclosingFunction) return;

  const scopeNode = node.childForFieldName('scope');
  const nameNode = node.childForFieldName('name');
  if (!scopeNode || !nameNode) return;

  const className = scopeNode.text;
  const methodName = nameNode.text;

  // Skip Route:: calls (handled above)
  if (className === 'Route') return;

  let operation: 'read' | 'write' | 'delete' | null = null;
  if (ELOQUENT_READ.has(methodName)) operation = 'read';
  else if (ELOQUENT_WRITE.has(methodName)) operation = 'write';
  else if (ELOQUENT_DELETE.has(methodName)) operation = 'delete';
  else return;

  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      targetTableId: `table:${className}`,
    }),
    callSiteFunctionId: ctx.enclosingFunction.id,
    operation,
    orm: 'eloquent',
    rawQuery: null,
    confidence: 'inferred',
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      snippet: node.text.slice(0, 200),
      confidence: 'heuristic',
    },
  };
  ctx.emitNode(interaction);
}

/**
 * M1 fix: Only match member calls when the receiver is likely an Eloquent model.
 * Heuristic: the receiver chain must originate from a scoped call (Model::where()->get())
 * or the variable name suggests a model ($user->update(), $post->delete()).
 */
function detectEloquentMemberCall(ctx: PhpVisitContext, node: SyntaxNode): void {
  if (!ctx.enclosingFunction) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const methodName = nameNode.text;

  let operation: 'read' | 'write' | 'delete' | null = null;
  if (ELOQUENT_READ.has(methodName)) operation = 'read';
  else if (ELOQUENT_WRITE.has(methodName)) operation = 'write';
  else if (ELOQUENT_DELETE.has(methodName)) operation = 'delete';
  else return;

  // M1 fix: Validate the receiver is likely an Eloquent model
  const objectNode = node.childForFieldName('object');
  if (!objectNode) return;
  // Accept: $model->method(), $user->method(), Model::where()->method()
  // Reject: $this->method() (handled by class method detection), $request->method()
  const objText = objectNode.text;
  if (objText === '$this' || objText === '$request' || objText === '$response') return;
  // Accept if receiver is a scoped call chain (Model::where()->get())
  if (objectNode.type !== 'member_call_expression' && objectNode.type !== 'scoped_call_expression'
      && objectNode.type !== 'variable_name') return;

  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      targetTableId: 'table:eloquent',
    }),
    callSiteFunctionId: ctx.enclosingFunction.id,
    operation,
    orm: 'eloquent',
    rawQuery: null,
    confidence: 'inferred',
    evidence: {
      filePath: ctx.sourceFile.filePath,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      snippet: node.text.slice(0, 200),
      confidence: 'heuristic',
    },
  };
  ctx.emitNode(interaction);
}

function findFirstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i)!;
    // PHP string types: string, encapsed_string, or any quoted text
    if (child.type === 'encapsed_string' || child.type === 'string' ||
        child.text.startsWith("'") || child.text.startsWith('"')) {
      return child.text.slice(1, -1);
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Group prefix composition (#204)
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk lexical ancestors from a route call to find every enclosing
 * `Route::group(['prefix' => '/x'], function () { ... })` and
 * concatenate prefixes outer-to-inner.
 *
 * Returns '' when the call isn't inside any Route::group.
 */
function composeEnclosingGroupPrefix(routeCall: SyntaxNode): string {
  // Collect prefixes from outermost to innermost.
  const prefixes: string[] = [];
  let current: SyntaxNode | null = routeCall.parent;
  while (current) {
    if (current.type === 'anonymous_function_creation_expression') {
      // Walk further: argument → arguments → call_expression that
      // accepts the closure. The call could be either:
      //   - scoped_call_expression: `Route::group(['prefix' => '/x'], fn)`
      //   - member_call_expression: `Route::middleware('auth')->group(fn)`
      //                             `Route::prefix('v1')->group(fn)`
      const argParent = current.parent;
      const argsParent = argParent?.parent;
      const callParent = argsParent?.parent;
      if (callParent && isRouteGroupCall(callParent)) {
        const prefix = extractGroupPrefix(callParent);
        if (prefix) prefixes.unshift(prefix);
      }
    }
    current = current.parent;
  }
  let composed = '';
  for (const p of prefixes) {
    // Laravel convention is `'prefix' => 'api'` (no leading slash);
    // `'prefix' => '/api'` works too. Normalize so composed paths
    // always start with `/` and segments are slash-separated.
    const normalized = p.startsWith('/') ? p : '/' + p;
    composed = joinPaths(composed, normalized);
  }
  return composed;
}

/**
 * Match either form of Route::group:
 *   Route::group([...], fn)                      — scoped_call_expression
 *   Route::middleware(...)->group(fn)            — member_call_expression
 *   Route::prefix('/x')->group(fn)               — member_call_expression
 *   Route::prefix('/x')->middleware(...)->group(fn) — member_call chained
 *
 * For the chained forms, the chain's root must be a Route::<X> scoped
 * call. Any `prefix` and `group` method names in the chain are the
 * intended Laravel API.
 */
function isRouteGroupCall(node: SyntaxNode): boolean {
  if (node.type === 'scoped_call_expression') {
    const scope = node.childForFieldName('scope');
    const name = node.childForFieldName('name');
    return scope?.text === 'Route' && name?.text === 'group';
  }
  if (node.type === 'member_call_expression') {
    const name = node.childForFieldName('name');
    if (name?.text !== 'group') return false;
    return chainRootIsRouteFacade(node);
  }
  return false;
}

/** Walk a member_call_expression's `object` chain inward; return true
 *  if the chain root is `Route::<anything>`. */
function chainRootIsRouteFacade(memberCall: SyntaxNode): boolean {
  let current: SyntaxNode | null = memberCall.childForFieldName('object') ?? null;
  while (current) {
    if (current.type === 'scoped_call_expression') {
      const scope = current.childForFieldName('scope');
      return scope?.text === 'Route';
    }
    if (current.type === 'member_call_expression') {
      current = current.childForFieldName('object') ?? null;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Extract the `prefix` value from a Route::group call.
 *
 * Two source shapes:
 *   1. Array config:  `Route::group(['prefix' => '/x'], fn)` —
 *      the first argument is an array_creation_expression with
 *      array_element_initializers; pick the one keyed `'prefix'`.
 *   2. Chained method: `Route::prefix('/x')->group(fn)` or
 *      `Route::middleware(...)->prefix('/x')->group(fn)` — walk the
 *      member_call_expression's `object` chain inward and pick the
 *      first `prefix(<string>)` call we hit (innermost wins, since
 *      Laravel applies the most-recent prefix value).
 *
 * When both shapes exist on the same group, the array form wins —
 * Laravel actually merges, but the array's `prefix` is the canonical
 * source.
 */
function extractGroupPrefix(call: SyntaxNode): string | null {
  // Try the array-config shape first (works for both scoped and
  // member call forms).
  const args = call.childForFieldName('arguments');
  if (args) {
    let firstArg: SyntaxNode | null = null;
    for (let i = 0; i < args.childCount; i++) {
      const child = args.child(i)!;
      if (child.type === 'argument') {
        firstArg = child.namedChildCount > 0 ? child.namedChild(0) : null;
        break;
      }
    }
    if (firstArg && firstArg.type === 'array_creation_expression') {
      for (let i = 0; i < firstArg.childCount; i++) {
        const elem = firstArg.child(i)!;
        if (elem.type !== 'array_element_initializer') continue;
        if (elem.namedChildCount < 2) continue;
        const key = elem.namedChild(0)!;
        const value = elem.namedChild(1)!;
        const keyText = stripPhpStringQuotes(key.text);
        if (keyText !== 'prefix') continue;
        return stripPhpStringQuotes(value.text);
      }
    }
  }

  // Chained-method shape: only meaningful when the call itself is a
  // member_call_expression. Walk inward through `object` to find a
  // `prefix(<str>)` call.
  if (call.type === 'member_call_expression') {
    let current: SyntaxNode | null = call.childForFieldName('object') ?? null;
    while (current) {
      if (current.type === 'member_call_expression' || current.type === 'scoped_call_expression') {
        const name = current.childForFieldName('name');
        if (name?.text === 'prefix') {
          const innerArgs = current.childForFieldName('arguments');
          if (innerArgs) {
            const s = findFirstStringArg(innerArgs);
            if (s) return s;
          }
        }
        if (current.type === 'member_call_expression') {
          current = current.childForFieldName('object') ?? null;
          continue;
        }
        break; // scoped_call_expression — chain root reached
      }
      break;
    }
  }
  return null;
}

function stripPhpStringQuotes(text: string): string {
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
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
