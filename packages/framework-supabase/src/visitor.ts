import { Node } from 'ts-morph';
import {
  idFor,
  type APIEndpoint,
  type ClientSideAPICaller,
  type DatabaseInteraction,
  type DatabaseTable,
  type DatabaseOperation,
} from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence, SERVE_HANDLER_SUFFIX } from '@veoable/lang-ts';
import { edgeFunctionRoutePattern } from './edge-functions.js';

/**
 * Supabase framework visitor (#40).
 *
 * Detects Supabase client database operations:
 *   supabase.from('users').select('*')          → read
 *   supabase.from('users').insert({ ... })       → write
 *   supabase.from('users').update({ ... })       → update
 *   supabase.from('users').delete()              → delete
 *   supabase.from('users').upsert({ ... })       → write
 *
 * The table name is extracted from the .from('tableName') call.
 * The operation is determined by the terminal method in the chain.
 */

const READ_METHODS: ReadonlySet<string> = new Set([
  'select', 'maybeSingle', 'single',
]);

const WRITE_METHODS: ReadonlySet<string> = new Set([
  'insert', 'upsert',
]);

const UPDATE_METHODS: ReadonlySet<string> = new Set([
  'update',
]);

const DELETE_METHODS: ReadonlySet<string> = new Set([
  'delete',
]);

export function createSupabaseVisitor(systemId: string): TsFrameworkVisitor {
  const emittedTables = new Set<string>();
  // #254 — Edge Function APIEndpoints share an id with the one
  // `extractEdgeFunctions` (onProjectLoaded) emits. Multiple `serve(...)`
  // calls in one index file would all share that id (lineStart=1) and
  // overwrite each other, losing handler resolution for all but the
  // last call. Track which function-name we've already emitted for and
  // skip duplicates so the FIRST serve(...) wins, matching the
  // single-handler convention of Edge Functions in practice.
  const emittedEdgeEndpoints = new Set<string>();

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      // #254 — Edge Function handler resolution. `serve(arrow)` and
      // `Deno.serve(arrow)` calls in `supabase/functions/<name>/index.*`
      // are the canonical Edge Function entry points. Emit an
      // APIEndpoint whose handlerFunctionId points at the arrow's
      // FunctionDefinition so the flow walker can traverse INTO the
      // handler. Runs BEFORE the enclosingFunction guard because the
      // serve call is at module scope.
      const edgeEndpoint = matchEdgeFunctionServe(node, ctx);
      if (edgeEndpoint) {
        if (!emittedEdgeEndpoints.has(edgeEndpoint.id)) {
          emittedEdgeEndpoints.add(edgeEndpoint.id);
          ctx.emitNode(edgeEndpoint);
        }
        return;
      }

      if (!ctx.enclosingFunction) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;

      const methodName = callee.getNameNode().getText();

      // #191 — `supabase.functions.invoke('<name>', ...)` client call.
      // Emits a ClientSideAPICaller pointing at the canonical Edge
      // Function URL `/functions/v1/<name>` so #190's APIEndpoint
      // stitches automatically.
      if (methodName === 'invoke') {
        const invokeCaller = matchSupabaseInvoke(node, callee, ctx);
        if (invokeCaller) {
          ctx.emitNode(invokeCaller);
          ctx.emitEdge({
            edgeType: 'MAKES_REQUEST',
            from: ctx.enclosingFunction.id,
            to: invokeCaller.id,
          });
          return;
        }
      }

      // Determine operation type from the method name.
      const ownOperation = operationFor(methodName);
      if (!ownOperation) return;

      // #252 — dedup chained calls. A chain like
      // `.from('t').select('*').eq('id', 1).single()` would emit one
      // interaction per matching method (select + single = 2). Walk
      // UP the chain; if any ancestor CallExpression in this chain
      // also matches, defer to it — only the topmost match emits.
      const topmost = findChainTopmostMatch(node);
      if (topmost !== node) return;

      // Walk DOWN from the topmost matching call to determine the
      // dominant operation across the chain. Precedence: delete >
      // update > write > read. This keeps `.insert(x).select()` a
      // write (the user-intent), not a read.
      const operation = strongestOperationInChain(node);

      // Walk up the chain to find .from('tableName').
      const tableName = findFromTable(callee);
      if (!tableName) return;

      // Check that the chain starts with a supabase-like receiver.
      if (!isSupabaseChain(callee)) return;

      const tableId = idFor.databaseTable({
        systemId,
        schema: null,
        name: tableName,
      });

      // Emit DatabaseTable node if not already emitted.
      if (!emittedTables.has(tableId)) {
        emittedTables.add(tableId);
        const table: DatabaseTable = {
          nodeType: 'DatabaseTable',
          id: tableId,
          systemId,
          name: tableName,
          schema: null,
          kind: 'table',
          declaredIn: null,
        };
        ctx.emitNode(table);
        ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
      }

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'supabase',
        rawQuery: null,
        confidence: 'direct',
        evidence: buildEvidence(node, ctx.sourceFile.filePath),
      };

      ctx.emitNode(interaction);

      // Emit READS or WRITES edge.
      if (operation === 'read') {
        ctx.emitEdge({
          edgeType: 'READS',
          from: interaction.id,
          to: tableId,
          columns: null,
          filters: null,
        });
      } else {
        const kind = operation === 'delete' ? 'delete'
          : operation === 'update' ? 'update'
          : 'insert';
        ctx.emitEdge({
          edgeType: 'WRITES',
          from: interaction.id,
          to: tableId,
          columns: null,
          kind,
        });
      }

      // Emit PERFORMED_BY edge.
      ctx.emitEdge({
        edgeType: 'PERFORMED_BY',
        from: interaction.id,
        to: ctx.enclosingFunction.id,
        sourceLine: node.getStartLineNumber(),
      });
    },
  };
}

// Match the path `supabase/functions/<name>/index.{ts|tsx|js|mjs}` and
// return `<name>`, or null if the file isn't an Edge Function entry.
function edgeFunctionNameFromPath(filePath: string): string | null {
  const m = /(?:^|\/)supabase\/functions\/([^/]+)\/index\.(?:ts|tsx|js|mjs)$/.exec(filePath);
  if (!m) return null;
  const name = m[1];
  // Mirrors findEdgeFunctions: skip _shared and dotfiles.
  if (name.startsWith('_') || name.startsWith('.')) return null;
  return name;
}

/**
 * #254 — match a top-level `serve(handler)` or `Deno.serve(handler)` call
 * inside a `supabase/functions/<name>/index.*` file. When found, build
 * an APIEndpoint (matching #190's id) with `handlerFunctionId` populated
 * from the handler arrow's emitted FunctionDefinition, so the flow
 * walker can traverse INTO the Edge Function body.
 *
 * The handler arrow is emitted by lang-ts with name `<module>.serve$handler`
 * (Pattern 5 in `inferCallbackName`). We compute the same id here.
 */
function matchEdgeFunctionServe(
  call: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): APIEndpoint | null {
  if (!Node.isCallExpression(call)) return null;
  const fnName = edgeFunctionNameFromPath(ctx.sourceFile.filePath);
  if (!fnName) return null;

  const callee = call.getExpression();
  let isServe = false;
  if (Node.isIdentifier(callee) && callee.getText() === 'serve') {
    isServe = true;
  } else if (
    Node.isPropertyAccessExpression(callee) &&
    callee.getNameNode().getText() === 'serve' &&
    Node.isIdentifier(callee.getExpression()) &&
    callee.getExpression().getText() === 'Deno'
  ) {
    isServe = true;
  }
  if (!isServe) return null;

  const args = call.getArguments();
  const handler = args.find(
    (a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a),
  );
  if (!handler) return null;

  const routePattern = edgeFunctionRoutePattern(fnName);
  // Mirror the name lang-ts emits for the inline arrow (Pattern 5).
  // Prefix is the enclosing function's name, or '<module>' for a
  // top-level serve(...) call. This MUST match the prefix lang-ts
  // computes (`state.functionStack[state.functionStack.length - 1]`)
  // so the FunctionDefinition.id resolves to a real node.
  const prefix = ctx.enclosingFunction?.name ?? '<module>';
  const handlerName = `${prefix}${SERVE_HANDLER_SUFFIX}`;
  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: handlerName,
    sourceLine: handler.getStartLineNumber(),
  });

  return {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'POST',
      routePattern,
      filePath: ctx.sourceFile.filePath,
      lineStart: 1,
    }),
    httpMethod: 'POST',
    routePattern,
    handlerFunctionId,
    framework: 'supabase-edge',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(call, ctx.sourceFile.filePath),
  };
}

// Peel ts-morph wrappers that don't change the value of an expression
// but break naive AST walks: `expr!`, `(expr)`, `expr as T`, `<T>expr`.
// Both up-walks and down-walks normalize through these so a chain like
// `supabase.from('t')!.insert(x).select().single()` walks transparently.
function unwrapExpr(node: Node | undefined): Node | undefined {
  let cur = node;
  while (cur) {
    if (Node.isNonNullExpression(cur)) cur = cur.getExpression();
    else if (Node.isParenthesizedExpression(cur)) cur = cur.getExpression();
    else if (Node.isAsExpression(cur)) cur = cur.getExpression();
    else if (Node.isTypeAssertion(cur)) cur = cur.getExpression();
    else break;
  }
  return cur;
}

// Map a Supabase chain method name to its DatabaseOperation, or null
// if the method isn't one of the four canonical operations.
function operationFor(methodName: string): DatabaseOperation | null {
  if (READ_METHODS.has(methodName)) return 'read';
  if (WRITE_METHODS.has(methodName)) return 'write';
  if (UPDATE_METHODS.has(methodName)) return 'update';
  if (DELETE_METHODS.has(methodName)) return 'delete';
  return null;
}

// Walk UP the chain from `node` to find the topmost CallExpression
// whose method matches a Supabase operation. Returns `node` itself
// when nothing higher matches (i.e., this call IS the topmost).
//
// AST shape for `a.b().c()`:
//   CallExpr(.c) → PropAccess(.c) → CallExpr(.b) → PropAccess(.b) → a
// Walking UP from inner CallExpr `b()`:
//   parent  = PropAccess(.c) where parent.expression === b()
//   grand   = CallExpr(.c)   where grand.expression  === parent
function findChainTopmostMatch(node: Node): Node {
  let cursor: Node = node;
  let topmost: Node = node;
  while (true) {
    // Skip wrappers between this call and the next chained method:
    // `from('t')!.select()`, `(from('t')).select()`, `from('t') as Q.select()`.
    let parent: Node | undefined = cursor.getParent();
    while (parent && (
      Node.isNonNullExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isTypeAssertion(parent)
    )) {
      parent = parent.getParent();
    }
    if (!parent || !Node.isPropertyAccessExpression(parent)) break;
    if (unwrapExpr(parent.getExpression()) !== cursor) break;
    const grand = parent.getParent();
    if (!grand || !Node.isCallExpression(grand)) break;
    if (grand.getExpression() !== parent) break;
    cursor = grand;
    if (operationFor(parent.getNameNode().getText())) topmost = grand;
  }
  return topmost;
}

// Walk DOWN from a CallExpression through its callee chain, returning
// the strongest-precedence operation present. Precedence (low → high):
// read < write < update < delete. The dominant operation drives the
// emitted DatabaseInteraction's `operation` field, so a pattern like
// `.from('t').insert(x).select()` is correctly classified as a write.
function strongestOperationInChain(topmostCall: Node): DatabaseOperation {
  // Only the four operations the visitor classifies appear here;
  // 'upsert' and 'raw' are valid DatabaseOperation values but the
  // visitor doesn't synthesize them.
  const order: Record<string, number> = {
    read: 0, write: 1, update: 2, delete: 3,
  };
  let best: DatabaseOperation = 'read';
  let cursor: Node | undefined = topmostCall;
  while (cursor && Node.isCallExpression(cursor)) {
    const expr = cursor.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) break;
    const op = operationFor(expr.getNameNode().getText());
    if (op && order[op] > order[best]) best = op;
    cursor = unwrapExpr(expr.getExpression());
  }
  return best;
}

// Walk down the property access chain to find .from('tableName').
// Chain: supabase.from('users').select('*').eq('id', 1).single()
// AST:   CallExpr(.single) → PropAccess → CallExpr(.eq) → PropAccess → CallExpr(.select) → PropAccess → CallExpr(.from) → PropAccess → Identifier(supabase)
// The walk peels through `!`, `(...)`, and `as T` so chains broken
// up by these wrappers still resolve.
function findFromTable(node: Node): string | null {
  let current: Node | undefined = node;
  while (current) {
    current = unwrapExpr(current);
    if (!current) break;
    if (Node.isCallExpression(current)) {
      const expr = current.getExpression();
      if (Node.isPropertyAccessExpression(expr) && expr.getNameNode().getText() === 'from') {
        const args = current.getArguments();
        if (args.length > 0 && Node.isStringLiteral(args[0])) {
          return args[0].getLiteralValue();
        }
      }
      current = expr;
    } else if (Node.isPropertyAccessExpression(current)) {
      current = current.getExpression();
    } else {
      break;
    }
  }
  return null;
}

// Shared name-match heuristic for supabase-like client identifiers.
function isSupabaseLikeName(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'supabase' || n.includes('supabase') || n === 'sb';
}

// Check if the chain involves a supabase-like receiver.
// Peels `!`, `(...)`, `as T`, `<T>x` so wrapped chains still resolve.
function isSupabaseChain(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    current = unwrapExpr(current);
    if (!current) break;
    if (Node.isIdentifier(current)) {
      return isSupabaseLikeName(current.getText());
    }
    if (Node.isPropertyAccessExpression(current)) {
      current = current.getExpression();
    } else if (Node.isCallExpression(current)) {
      current = current.getExpression();
    } else {
      break;
    }
  }
  return false;
}

/**
 * #191 — supabase-like receiver detection for the
 * `<receiver>.functions.invoke` chain.
 *
 * Accepts:
 *   - Identifier whose name is supabase-like (`supabase`, `sb`,
 *     anything containing `supabase`).
 *   - PropertyAccessExpression whose tail name is supabase-like
 *     (e.g., `this.supabase`, `module.supabase`).
 */
function isSupabaseLikeReceiver(node: Node): boolean {
  if (Node.isIdentifier(node)) return isSupabaseLikeName(node.getText());
  if (Node.isPropertyAccessExpression(node)) return isSupabaseLikeName(node.getNameNode().getText());
  return false;
}

/**
 * #191 — match a `supabase.functions.invoke('<name>', ...)` call and
 * build a `ClientSideAPICaller` whose URL points at the canonical
 * Edge Function path emitted by #190.
 *
 * Shape:
 *   <callExpr>
 *     callee: <propAccess>.invoke
 *       expression: <propAccess>.functions
 *         expression: <Identifier supabase>
 *
 * The receiver chain must end at a supabase-like identifier (same
 * heuristic as `isSupabaseChain`) AND the property path must be
 * `<receiver>.functions.invoke`. The first arg must be a string
 * literal (the function name).
 *
 * Returns null when the shape doesn't match — this is the conservative
 * gate that prevents false positives from unrelated `.invoke()`
 * methods on non-Supabase receivers.
 */
function matchSupabaseInvoke(
  call: Node,
  callee: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): ClientSideAPICaller | null {
  if (!Node.isCallExpression(call)) return null;
  if (!Node.isPropertyAccessExpression(callee)) return null;
  if (callee.getNameNode().getText() !== 'invoke') return null;

  // Receiver of `.invoke` must itself be a property access ending in `.functions`.
  const receiverOfInvoke = callee.getExpression();
  if (!Node.isPropertyAccessExpression(receiverOfInvoke)) return null;
  if (receiverOfInvoke.getNameNode().getText() !== 'functions') return null;

  // Receiver of `.functions` must be a supabase-like identifier or
  // a property access whose tail name is supabase-like (e.g.,
  // `this.supabase.functions.invoke` — the receiver of `.functions`
  // is `this.supabase`, whose name node is `supabase`).
  const receiverOfFunctions = receiverOfInvoke.getExpression();
  if (!isSupabaseLikeReceiver(receiverOfFunctions)) return null;

  const args = call.getArguments();
  if (args.length === 0) return null;
  const first = args[0];

  let functionName: string | null = null;
  if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
    functionName = first.getLiteralValue();
  }
  if (!functionName) return null;

  const urlLiteral = edgeFunctionRoutePattern(functionName);
  if (!ctx.enclosingFunction) return null;

  return {
    nodeType: 'ClientSideAPICaller',
    id: idFor.clientSideAPICaller({
      sourceFileId: ctx.sourceFile.id,
      sourceLine: call.getStartLineNumber(),
      urlLiteral,
    }),
    functionId: ctx.enclosingFunction.id,
    sourceFileId: ctx.sourceFile.id,
    sourceLine: call.getStartLineNumber(),
    httpMethod: 'POST',
    urlLiteral,
    egressConfidence: 'exact',
    framework: 'supabase-functions',
    repository: ctx.sourceFile.repository,
    evidence: buildEvidence(call, ctx.sourceFile.filePath),
  };
}
