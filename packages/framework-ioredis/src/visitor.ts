import { Node, type Expression } from 'ts-morph';
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
  type TsVisitContext,
} from '@adorable/lang-ts';

/**
 * ioredis / node-redis visitor.
 *
 * Mirrors framework-redispy (Python), framework-goredis (Go), and
 * framework-redisrs (Rust). Same verb map (~50 verbs), same emit
 * shape: `DatabaseInteraction` + `DatabaseTable` (kind='table' as
 * the closest fit for a Redis key), `kind='redis'` system.
 *
 * Per-file gate: file must import from `'ioredis'` or `'redis'`.
 *
 * Receiver discrimination: TS lacks Python-style runtime introspection,
 * so we use a name-based heuristic — receiver text must match a
 * conservative list of common Redis variable names. False negatives
 * here are acceptable; false positives across the whole codebase
 * (e.g. `dict.get`) are not.
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
  ['srandmember', { op: 'read' }],
  ['zrange', { op: 'read' }],
  ['zrevrange', { op: 'read' }],
  ['zscore', { op: 'read' }],
  ['zcard', { op: 'read' }],
  ['exists', { op: 'read' }],
  ['type', { op: 'read' }],
  ['ttl', { op: 'read' }],
  ['keys', { op: 'read' }],
  ['scan', { op: 'read' }],
  ['subscribe', { op: 'read' }],
  ['psubscribe', { op: 'read' }],

  // Updates
  ['set', { op: 'update' }],
  ['setex', { op: 'update' }],
  ['setnx', { op: 'update' }],
  ['getset', { op: 'update' }],
  ['mset', { op: 'update' }],
  ['msetnx', { op: 'update' }],
  ['append', { op: 'update' }],
  ['incr', { op: 'update' }],
  ['incrby', { op: 'update' }],
  ['incrbyfloat', { op: 'update' }],
  ['decr', { op: 'update' }],
  ['decrby', { op: 'update' }],
  ['hset', { op: 'update' }],
  ['hmset', { op: 'update' }],
  ['hsetnx', { op: 'update' }],
  ['hincrby', { op: 'update' }],
  ['hincrbyfloat', { op: 'update' }],
  ['lpush', { op: 'insert' }],
  ['rpush', { op: 'insert' }],
  ['lpushx', { op: 'insert' }],
  ['rpushx', { op: 'insert' }],
  ['lpop', { op: 'delete' }],
  ['rpop', { op: 'delete' }],
  ['lset', { op: 'update' }],
  ['linsert', { op: 'insert' }],
  ['sadd', { op: 'insert' }],
  ['srem', { op: 'delete' }],
  ['zadd', { op: 'insert' }],
  ['zrem', { op: 'delete' }],
  ['zincrby', { op: 'update' }],
  ['expire', { op: 'update' }],
  ['expireat', { op: 'update' }],
  ['persist', { op: 'update' }],
  ['rename', { op: 'update' }],
  ['renamenx', { op: 'update' }],
  ['publish', { op: 'update' }],

  // Deletes
  ['del', { op: 'delete' }],
  ['unlink', { op: 'delete' }],
  ['flushdb', { op: 'delete' }],
  ['flushall', { op: 'delete' }],
  ['hdel', { op: 'delete' }],
]);

const RECEIVER_RE = /^(?:self\.)?(?:redis|client|cache|rdb|rc|r|conn|connection|publisher|subscriber|store|kv)$/i;

export function createIoredisVisitor(systemId?: string): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'redis', name: 'ioredis' });

  const fileImportsRedis = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === 'ioredis' || spec.startsWith('ioredis/')
        || spec === 'redis' || spec.startsWith('redis/');
    });
    importsByFile.set(filePath, has);
    return has;
  };

  const ensureTable = (ctx: TsVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId: resolvedSystemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId: resolvedSystemId,
        name,
        schema: null,
        kind: 'table',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: resolvedSystemId });
    }
    return tableId;
  };

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      if (!fileImportsRedis(node, ctx.sourceFile.filePath)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();
      const verb = REDIS_VERBS.get(methodName);
      if (!verb) return;

      const receiverText = callee.getExpression().getText();
      if (!RECEIVER_RE.test(receiverText)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.getArguments();
      const keyName = resolveKey(args[0] as Expression | undefined, ctx, node);

      const tableId = ensureTable(ctx, keyName);
      const operation: DatabaseOperation = toCanonicalOp(verb.op);
      const evidence = buildEvidence(node, ctx.sourceFile.filePath);

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'ioredis',
        rawQuery: null,
        confidence: 'direct',
        evidence,
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
        sourceLine: evidence.lineStart,
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
 * Resolve a Redis key from the first argument.
 *
 *   'user:1'                  → 'user:1'
 *   `user:${id}`              → 'user:*'  (literal prefix only)
 *   anything else             → '<dynamic:<file>:<line>>'  (per-call-site)
 */
function resolveKey(arg: Expression | undefined, ctx: TsVisitContext, node: Node): string {
  if (arg) {
    const literal = readStringLiteral(arg);
    if (literal !== null) return literal;
    if (Node.isTemplateExpression(arg)) {
      const head = arg.getHead().getLiteralText();
      if (head.length > 0) return `${head}*`;
    }
    if (Node.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.getLiteralText();
    }
  }
  // Per-call-site placeholder so unrelated dynamic-key calls don't
  // bucket into one shared synthetic table.
  const stem = ctx.sourceFile.filePath.split('/').slice(-1)[0];
  const line = node.getStartLineNumber();
  return `<dynamic:${stem}:${line}>`;
}
