import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@adorable/lang-py';

/**
 * redis-py visitor.
 *
 * Call shape: `<client>.<verb>(<key>, ...)`
 *
 * Client identification:
 *   1. Per-file scan for `<name> = redis.Redis(...)`,
 *      `<name> = redis.from_url(...)`, `<name> = StrictRedis(...)`,
 *      `<name> = aioredis.Redis(...)` bindings.
 *   2. Bare-name heuristic: receivers named `redis`, `redis_client`,
 *      `r`, `cache`, `rcli`, `kv` matched without explicit binding
 *      (the file-level redis-import gate keeps false positives away).
 *
 * Key resolution:
 *   - String literal: literal value used as the table name.
 *   - f-string with literals + interpolations: prefix up to the
 *     first `{` is the table name (e.g. `user:{uid}` → `user:*`).
 *   - Otherwise: table name is `<dynamic>`.
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

  // Writes / updates
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
  ['delete', { op: 'delete' }],  // redis-py's canonical delete method
  ['del', { op: 'delete' }],     // raw command name alias
  ['unlink', { op: 'delete' }],
  ['flushdb', { op: 'delete' }],
  ['flushall', { op: 'delete' }],
  ['hdel', { op: 'delete' }],
]);

const RECEIVER_RE = /^(?:self\.)?(?:.*(?:redis|cache|kv|rdb|rcli).*|r)$/i;

export function createRedispyVisitor(systemId: string): PyFrameworkVisitor {
  const emittedTables = new Set<string>();
  const importsByFile = new Map<string, boolean>();
  const clientsByFile = new Map<string, Set<string>>();

  const fileImportsRedis = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImports(root);
    importsByFile.set(filePath, value);
    return value;
  };

  const getClients = (filePath: string, root: SyntaxNode): Set<string> => {
    let s = clientsByFile.get(filePath);
    if (!s) {
      s = scanFileForRedisClientBindings(root);
      clientsByFile.set(filePath, s);
    }
    return s;
  };

  const ensureTable = (ctx: PyVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId,
        name,
        schema: null,
        // Schema's DatabaseTableKind enum currently allows
        // 'table' / 'view' / 'collection'. Redis keys aren't really
        // tables — we pick 'table' as the closest fit. A follow-up
        // can extend the enum to include 'key' / 'namespace'.
        kind: 'table',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
    }
    return tableId;
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImportsRedis(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') return;
      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute');
      if (!obj || !attr) return;

      const verb = REDIS_VERBS.get(attr.text);
      if (!verb) return;

      const receiverText = obj.text;
      const clients = getClients(ctx.sourceFile.filePath, node.tree.rootNode);

      // Receiver must be in the bindings OR match the name heuristic.
      const isClient = clients.has(receiverText)
        || clients.has(lastDottedSegment(receiverText))
        || RECEIVER_RE.test(receiverText);
      if (!isClient) return;

      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      let keyName = args ? resolveKey(args) : '<dynamic>';
      // Per-call-site placeholder for fully dynamic keys. Without
      // this, every dynamic-key call across the project collapses
      // into a single synthetic '<dynamic>' table that the
      // flow-stitcher treats as connected — implying interactions
      // that don't really share a key. Use a per-(file:line)
      // unique placeholder instead.
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
        orm: 'redispy',
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
 * Resolve a Redis key from a call's argument list.
 *
 *   "user:1"               → 'user:1'
 *   f"user:{uid}"          → 'user:*'  (literal prefix only)
 *   "user:" + str(uid)     → 'user:*'  (best-effort prefix from
 *                                       a binary +)
 *   uid                    → '<dynamic>'
 *   getattr / no first arg → '<dynamic>'
 */
function resolveKey(args: SyntaxNode): string {
  const firstArg = firstPositionalArg(args);
  if (!firstArg) return '<dynamic>';

  if (firstArg.type === 'string') {
    const lit = stripPythonString(firstArg.text);
    if (lit !== null) return lit;
    // f-string with interpolations.
    const prefix = extractFStringPrefix(firstArg.text);
    if (prefix) return `${prefix}*`;
    return '<dynamic>';
  }
  if (firstArg.type === 'concatenated_string') {
    let combined = '';
    for (let i = 0; i < firstArg.childCount; i++) {
      const c = firstArg.child(i);
      if (!c || c.type !== 'string') return '<dynamic>';
      const lit = stripPythonString(c.text);
      if (lit === null) return '<dynamic>';
      combined += lit;
    }
    if (combined.length > 0) return combined;
  }
  if (firstArg.type === 'binary_operator') {
    // `"prefix:" + something` — extract the leftmost string literal.
    const left = firstArg.childForFieldName('left');
    if (left && left.type === 'string') {
      const prefix = stripPythonString(left.text);
      if (prefix) return `${prefix}*`;
    }
  }
  return '<dynamic>';
}

function firstPositionalArg(args: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    return c;
  }
  return null;
}

function stripPythonString(text: string): string | null {
  let s = text;
  if (/^[rRbBuU]*[fF]/.test(s)) return null;
  s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return null;
}

/**
 * Extract the literal prefix from an f-string before the first
 * interpolation. `f"user:{uid}"` → 'user:'. Returns null when no
 * literal prefix exists.
 */
function extractFStringPrefix(text: string): string | null {
  // Strip prefix sigils.
  let s = text.replace(/^[rRbBuU]*[fF][rRbBuU]*/, '');
  let quote: string;
  if (s.startsWith('"""') || s.startsWith("'''")) {
    quote = s.slice(0, 3);
    s = s.slice(3, -3);
  } else if (s.startsWith('"') || s.startsWith("'")) {
    quote = s.slice(0, 1);
    s = s.slice(1, -1);
  } else {
    return null;
  }
  void quote;
  const idx = s.indexOf('{');
  if (idx <= 0) return null;
  return s.slice(0, idx);
}

function lastDottedSegment(text: string): string {
  const i = text.lastIndexOf('.');
  return i >= 0 ? text.slice(i + 1) : text;
}

/**
 * Per-file scan for `<name> = redis.Redis(...)` and similar Redis
 * client bindings. Returns the set of identifiers that hold a Redis
 * client instance.
 */
function scanFileForRedisClientBindings(rootNode: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right) {
        const name = extractAssignedName(left);
        if (name && isRedisConstructor(right)) out.add(name);
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return out;
}

function extractAssignedName(left: SyntaxNode): string | null {
  if (left.type === 'identifier') return left.text;
  if (left.type === 'attribute') {
    const attr = left.childForFieldName('attribute');
    return attr?.text ?? null;
  }
  return null;
}

/**
 * Detect canonical Redis client constructor calls:
 *   redis.Redis(...)
 *   redis.StrictRedis(...)
 *   redis.from_url(...)
 *   redis.Redis.from_url(...)
 *   redis.ConnectionPool(...)   ← not a client, but commonly used
 *                                   to feed `Redis(connection_pool=...)`
 *   aioredis.Redis(...)
 *   aioredis.from_url(...)
 *   StrictRedis(...)           ← bare import form
 *   Redis(...)                 ← bare import form (after
 *                                 `from redis import Redis`)
 */
function isRedisConstructor(rhs: SyntaxNode): boolean {
  if (rhs.type !== 'call') return false;
  const fn = rhs.childForFieldName('function');
  if (!fn) return false;
  const text = fn.text;
  if (/^(?:redis|aioredis)(?:\.[A-Za-z_][\w]*)*\.(?:Redis|StrictRedis|from_url)$/.test(text)) return true;
  if (text === 'Redis' || text === 'StrictRedis') return true;
  if (/^aioredis\.(?:from_url|Redis)$/.test(text)) return true;
  return false;
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
    const text = c.text;
    if (text.includes('redis') || text.includes('aioredis')) return true;
  }
  return false;
}
