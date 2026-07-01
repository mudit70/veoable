import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@veoable/lang-rust';

/**
 * redis-rs visitor.
 *
 * Call shape: `<conn>.<verb>(<key>, ...)` where `<verb>` is a
 * lowercase Redis command method on the Commands trait.
 *
 * Conn identification — receivers that look like a Redis connection:
 *   conn / connection / redis_conn / rdb / rc / cache
 *   + per-file scan for `let mut conn = client.get_connection()?;`
 *
 * Key resolution:
 *   - String literal `"user:1"` → 'user:1'
 *   - format!("user:{}", id) → 'user:*' (literal prefix only)
 *   - Anything else → per-call-site `<dynamic:<file>:<line>>`
 *     placeholder (so unrelated dynamic-key calls don't bucket).
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const REDIS_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['get', { op: 'read' }],
  ['mget', { op: 'read' }],
  ['hget', { op: 'read' }],
  ['hmget', { op: 'read' }],
  ['hgetall', { op: 'read' }],
  ['hexists', { op: 'read' }],
  ['hkeys', { op: 'read' }],
  ['hvals', { op: 'read' }],
  ['hlen', { op: 'read' }],
  ['lrange', { op: 'read' }],
  ['llen', { op: 'read' }],
  ['lindex', { op: 'read' }],
  ['smembers', { op: 'read' }],
  ['sismember', { op: 'read' }],
  ['scard', { op: 'read' }],
  ['zrange', { op: 'read' }],
  ['zrevrange', { op: 'read' }],
  ['zscore', { op: 'read' }],
  ['zcard', { op: 'read' }],
  ['exists', { op: 'read' }],
  ['ttl', { op: 'read' }],
  ['keys', { op: 'read' }],
  ['scan', { op: 'read' }],
  ['subscribe', { op: 'read' }],
  ['psubscribe', { op: 'read' }],

  // Updates / inserts
  ['set', { op: 'update' }],
  ['set_ex', { op: 'update' }],
  ['set_nx', { op: 'update' }],
  ['getset', { op: 'update' }],
  ['mset', { op: 'update' }],
  ['append', { op: 'update' }],
  ['incr', { op: 'update' }],
  ['incr_by', { op: 'update' }],
  ['decr', { op: 'update' }],
  ['decr_by', { op: 'update' }],
  ['hset', { op: 'update' }],
  ['hset_nx', { op: 'update' }],
  ['hincr_by', { op: 'update' }],
  ['lset', { op: 'update' }],
  ['expire', { op: 'update' }],
  ['persist', { op: 'update' }],
  ['rename', { op: 'update' }],
  ['rename_nx', { op: 'update' }],
  ['publish', { op: 'update' }],
  ['lpush', { op: 'insert' }],
  ['rpush', { op: 'insert' }],
  ['linsert_before', { op: 'insert' }],
  ['linsert_after', { op: 'insert' }],
  ['sadd', { op: 'insert' }],
  ['zadd', { op: 'insert' }],

  // Deletes
  ['del', { op: 'delete' }],
  ['unlink', { op: 'delete' }],
  ['flushdb', { op: 'delete' }],
  ['flushall', { op: 'delete' }],
  ['hdel', { op: 'delete' }],
  ['lpop', { op: 'delete' }],
  ['rpop', { op: 'delete' }],
  ['srem', { op: 'delete' }],
  ['zrem', { op: 'delete' }],
]);

const RECEIVER_RE = /^(?:self\.)?(?:.*(?:conn|redis|cache|kv|rdb|rcli|rc).*)$/i;

export function createRedisrsVisitor(systemId: string): RustFrameworkVisitor {
  const emittedTables = new Set<string>();
  const importsByFile = new Map<string, boolean>();

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = hasCrateImport(root, 'redis');
    importsByFile.set(filePath, value);
    return value;
  };

  const ensureTable = (ctx: RustVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId,
        name,
        schema: null,
        // Schema enum is 'table' | 'view' | 'collection'. Redis keys
        // use 'table' as the closest fit.
        kind: 'table',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
    }
    return tableId;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // Match `<recv>.<verb>(args)` — a field_expression OR the
      // turbofish form `<recv>.<verb>::<T, U>` which wraps in a
      // generic_function.
      let fieldExpr: SyntaxNode = fn;
      if (fn.type === 'generic_function') {
        const inner = fn.childForFieldName('function');
        if (!inner || inner.type !== 'field_expression') return;
        fieldExpr = inner;
      } else if (fn.type !== 'field_expression') {
        return;
      }

      const fieldName = fieldExpr.childForFieldName('field');
      const operand = fieldExpr.childForFieldName('value');
      if (!fieldName || !operand) return;

      const verb = REDIS_VERBS.get(fieldName.text);
      if (!verb) return;

      // Receiver heuristic — must look like a Redis connection.
      if (!RECEIVER_RE.test(operand.text)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      let keyName = args ? resolveKey(args) : '<dynamic>';
      if (keyName === '<dynamic>') {
        const line = node.startPosition.row + 1;
        const stem = ctx.sourceFile.filePath.split('/').slice(-1)[0];
        keyName = `<dynamic:${stem}:${line}>`;
      }

      const tableId = ensureTable(ctx, keyName);
      const operation: DatabaseOperation = toCanonicalOp(verb.op);

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'redisrs',
        rawQuery: null,
        confidence: 'direct',
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          snippet: node.text.slice(0, 200),
          confidence: 'exact',
        },
      };
      ctx.emitNode(interaction);

      if (operation === 'read') {
        ctx.emitEdge({ edgeType: 'READS', from: interaction.id, to: tableId, columns: null, filters: null });
      } else {
        const kind = operation === 'delete' ? 'delete' : operation === 'update' ? 'update' : 'insert';
        ctx.emitEdge({ edgeType: 'WRITES', from: interaction.id, to: tableId, columns: null, kind });
      }
      ctx.emitEdge({
        edgeType: 'PERFORMED_BY',
        from: interaction.id,
        to: ctx.enclosingFunction.id,
        sourceLine: node.startPosition.row + 1,
      });
    },
  };
}

function toCanonicalOp(op: 'read' | 'insert' | 'update' | 'delete'): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
    default: return 'read';
  }
}

/**
 * Resolve the first arg as a Redis key.
 *
 *   "user:1"                       → 'user:1'
 *   format!("user:{}", id)         → 'user:*'
 *   &format!("user:{}", id)        → same after peeling &
 *   Anything else                  → '<dynamic>'
 */
function resolveKey(args: SyntaxNode): string {
  let arg = firstNonPunctChild(args);
  if (!arg) return '<dynamic>';

  // Peel one level of `&` reference.
  if (arg.type === 'reference_expression') {
    const v = arg.childForFieldName('value');
    if (v) arg = v;
  }

  if (arg.type === 'string_literal' || arg.type === 'raw_string_literal') {
    const lit = stripRustStringQuotes(arg.text);
    if (lit !== null) return lit;
  }
  // format!("user:{}", id) — macro invocation
  if (arg.type === 'macro_invocation') {
    const macroPath = arg.childForFieldName('macro');
    if (macroPath?.text === 'format') {
      const tokenTree = findChildOfType(arg, 'token_tree');
      if (tokenTree) {
        const firstString = findFirstStringInTokenTree(tokenTree);
        if (firstString !== null) {
          const idx = firstString.indexOf('{');
          if (idx > 0) return `${firstString.slice(0, idx)}*`;
          if (idx === 0) return '<dynamic>';
          return firstString;
        }
      }
    }
  }
  return '<dynamic>';
}

function firstNonPunctChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    return c;
  }
  return null;
}

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function findFirstStringInTokenTree(tokenTree: SyntaxNode): string | null {
  const walk = (n: SyntaxNode): string | null => {
    if (n.type === 'string_literal' || n.type === 'raw_string_literal') {
      return stripRustStringQuotes(n.text);
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (!c) continue;
      const v = walk(c);
      if (v !== null) return v;
    }
    return null;
  };
  return walk(tokenTree);
}

function stripRustStringQuotes(text: string): string | null {
  if (text.startsWith('r#"') && text.endsWith('"#')) return text.slice(3, -2);
  if (text.startsWith('r"') && text.endsWith('"')) return text.slice(2, -1);
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return null;
}
