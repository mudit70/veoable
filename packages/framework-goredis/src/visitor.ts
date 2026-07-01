import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';

/**
 * go-redis visitor.
 *
 * Call shape: `<client>.<Verb>(ctx, <key>, ...)`
 *
 * Client identification:
 *   1. Per-file scan for `<name> := redis.NewClient(...)`,
 *      `<name> := redis.NewClusterClient(...)`,
 *      `<name> := redis.NewFailoverClient(...)`,
 *      `<name> := redis.NewUniversalClient(...)` bindings.
 *   2. Bare-name heuristic: receivers named `rdb`, `redis_client`,
 *      `rc`, `cache`, `kv` matched without explicit binding.
 *
 * Key resolution:
 *   - Interpreted string literal `"user:1"` → 'user:1'
 *   - fmt.Sprintf("user:%d", id) → 'user:*' (literal prefix only)
 *   - Otherwise → '<dynamic>'
 *
 * The go-redis API takes context.Context as the FIRST argument and
 * the key as the SECOND (different from pymongo/redispy). The visitor
 * skips the first arg and resolves the key from the second.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const REDIS_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['Get', { op: 'read' }],
  ['MGet', { op: 'read' }],
  ['HGet', { op: 'read' }],
  ['HMGet', { op: 'read' }],
  ['HGetAll', { op: 'read' }],
  ['HExists', { op: 'read' }],
  ['HKeys', { op: 'read' }],
  ['HVals', { op: 'read' }],
  ['HLen', { op: 'read' }],
  ['LRange', { op: 'read' }],
  ['LLen', { op: 'read' }],
  ['LIndex', { op: 'read' }],
  ['SMembers', { op: 'read' }],
  ['SIsMember', { op: 'read' }],
  ['SCard', { op: 'read' }],
  ['ZRange', { op: 'read' }],
  ['ZRevRange', { op: 'read' }],
  ['ZScore', { op: 'read' }],
  ['ZCard', { op: 'read' }],
  ['Exists', { op: 'read' }],
  ['Type', { op: 'read' }],
  ['TTL', { op: 'read' }],
  ['Keys', { op: 'read' }],
  ['Scan', { op: 'read' }],
  ['Subscribe', { op: 'read' }],
  ['PSubscribe', { op: 'read' }],

  // Updates / inserts
  ['Set', { op: 'update' }],
  ['SetEX', { op: 'update' }],
  ['SetNX', { op: 'update' }],
  ['GetSet', { op: 'update' }],
  ['MSet', { op: 'update' }],
  ['Append', { op: 'update' }],
  ['Incr', { op: 'update' }],
  ['IncrBy', { op: 'update' }],
  ['Decr', { op: 'update' }],
  ['DecrBy', { op: 'update' }],
  ['HSet', { op: 'update' }],
  ['HSetNX', { op: 'update' }],
  ['HIncrBy', { op: 'update' }],
  ['LSet', { op: 'update' }],
  ['Expire', { op: 'update' }],
  ['ExpireAt', { op: 'update' }],
  ['Persist', { op: 'update' }],
  ['Rename', { op: 'update' }],
  ['RenameNX', { op: 'update' }],
  ['Publish', { op: 'update' }],
  ['LPush', { op: 'insert' }],
  ['RPush', { op: 'insert' }],
  ['LInsert', { op: 'insert' }],
  ['SAdd', { op: 'insert' }],
  ['ZAdd', { op: 'insert' }],

  // Deletes
  ['Del', { op: 'delete' }],
  ['Unlink', { op: 'delete' }],
  ['FlushDB', { op: 'delete' }],
  ['FlushAll', { op: 'delete' }],
  ['HDel', { op: 'delete' }],
  ['LPop', { op: 'delete' }],
  ['RPop', { op: 'delete' }],
  ['SRem', { op: 'delete' }],
  ['ZRem', { op: 'delete' }],
]);

const RECEIVER_RE = /^(?:[a-zA-Z_][\w]*\.)?(?:r|rdb|redis|cache|kv|rc|client|.*[Rr]edis.*|.*[Cc]ache.*)$/;

export function createGoredisVisitor(systemId: string): GoFrameworkVisitor {
  const emittedTables = new Set<string>();
  const importsByFile = new Map<string, boolean>();
  const clientsByFile = new Map<string, Set<string>>();

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
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

  const ensureTable = (ctx: GoVisitContext, name: string): string => {
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
        // picked 'table' as closest fit.
        kind: 'table',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
    }
    return tableId;
  };

  return {
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;
      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('operand');
      if (!field || !operand) return;

      const methodName = field.text;
      const verb = REDIS_VERBS.get(methodName);
      if (!verb) return;

      const receiverText = operand.text;
      const clients = getClients(ctx.sourceFile.filePath, node.tree.rootNode);
      const isClient =
        clients.has(receiverText)
        || (operand.type === 'selector_expression'
            && clients.has(operand.childForFieldName('field')?.text ?? ''))
        || RECEIVER_RE.test(receiverText);
      if (!isClient) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      // go-redis API: first arg is ctx, second is the key.
      let keyName = args ? resolveKeyAtIndex(args, 1) : '<dynamic>';
      // Per-call-site placeholder for fully dynamic keys so unrelated
      // dynamic-key calls don't collapse into a single synthetic
      // 'dynamic' table (reviewer-flagged on the redispy PR).
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
        orm: 'goredis',
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
 * Resolve the Nth positional arg as a key name. Index counts only
 * real arguments, skipping `(`, `,`, `)`.
 *
 *   "user:1"                     → 'user:1'
 *   fmt.Sprintf("user:%d", id)   → 'user:*' (literal prefix)
 *   keyVar                       → '<dynamic>'
 */
function resolveKeyAtIndex(args: SyntaxNode, index: number): string {
  const arg = nthArg(args, index);
  if (!arg) return '<dynamic>';

  if (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal') {
    return arg.text.slice(1, -1);
  }
  // fmt.Sprintf("user:%d", id) — extract the prefix before the first %.
  if (arg.type === 'call_expression') {
    const fn = arg.childForFieldName('function');
    if (fn && fn.type === 'selector_expression') {
      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('operand');
      if (
        field?.text === 'Sprintf'
        && operand?.type === 'identifier'
        && operand.text === 'fmt'
      ) {
        const subargs = arg.childForFieldName('arguments');
        if (subargs) {
          const format = nthArg(subargs, 0);
          if (format && (format.type === 'interpreted_string_literal' || format.type === 'raw_string_literal')) {
            const literal = format.text.slice(1, -1);
            const pctIdx = literal.indexOf('%');
            if (pctIdx > 0) return `${literal.slice(0, pctIdx)}*`;
            if (pctIdx === 0) return '<dynamic>';
            return literal;
          }
        }
      }
    }
  }
  return '<dynamic>';
}

function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

/**
 * Per-file scan for `<name> := redis.NewClient(...)` and family.
 * Returns a set of identifier names.
 */
function scanFileForRedisClientBindings(rootNode: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right) {
        const lefts = expressionListChildren(left);
        const rights = expressionListChildren(right);
        for (let i = 0; i < Math.min(lefts.length, rights.length); i++) {
          if (isRedisClientCall(rights[i])) {
            const name = lefts[i].text;
            // For selector-text bindings (s.rdb), bind under the
            // field name too.
            if (lefts[i].type === 'selector_expression') {
              const field = lefts[i].childForFieldName('field');
              if (field) out.add(field.text);
            }
            out.add(name);
          }
        }
      }
    }
    if (n.type === 'var_spec') {
      const name = n.childForFieldName('name');
      const value = n.childForFieldName('value');
      if (name && value) {
        const valueList = expressionListChildren(value);
        if (valueList.length > 0 && isRedisClientCall(valueList[0])) {
          out.add(name.text);
        }
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

function expressionListChildren(node: SyntaxNode): SyntaxNode[] {
  if (node.type === 'expression_list') {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || c.type === ',') continue;
      out.push(c);
    }
    return out;
  }
  return [node];
}

/**
 * Recognize the canonical go-redis client constructors:
 *   redis.NewClient(...)
 *   redis.NewClusterClient(...)
 *   redis.NewFailoverClient(...)
 *   redis.NewFailoverClusterClient(...)
 *   redis.NewUniversalClient(...)
 *   redis.NewRing(...)
 */
function isRedisClientCall(node: SyntaxNode): boolean {
  if (node.type !== 'call_expression') return false;
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return false;
  const operand = fn.childForFieldName('operand');
  const field = fn.childForFieldName('field');
  if (!operand || !field) return false;
  if (operand.type !== 'identifier' || operand.text !== 'redis') return false;
  return /^New(?:Client|ClusterClient|FailoverClient|FailoverClusterClient|SentinelClient|UniversalClient|Ring)$/.test(field.text);
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    if (c.text.includes('redis/go-redis') || c.text.includes('go-redis/redis')) return true;
  }
  return false;
}
