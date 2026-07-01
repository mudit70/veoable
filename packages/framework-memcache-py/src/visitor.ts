import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const MC_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['get', { op: 'read' }],
  ['get_many', { op: 'read' }],
  ['get_multi', { op: 'read' }],
  ['gets', { op: 'read' }],
  ['stats', { op: 'read' }],

  // Updates
  ['set', { op: 'update' }],
  ['set_many', { op: 'update' }],
  ['set_multi', { op: 'update' }],
  ['add', { op: 'insert' }],
  ['replace', { op: 'update' }],
  ['append', { op: 'update' }],
  ['prepend', { op: 'update' }],
  ['incr', { op: 'update' }],
  ['decr', { op: 'update' }],
  ['cas', { op: 'update' }],
  ['touch', { op: 'update' }],

  // Deletes
  ['delete', { op: 'delete' }],
  ['delete_many', { op: 'delete' }],
  ['delete_multi', { op: 'delete' }],
  ['flush_all', { op: 'delete' }],
]);

const RECEIVER_RE = /^(?:self\.)?(?:client|cache|mc|mem|memcache|memcached)$/;

export function createMemcachePyVisitor(systemId?: string): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'memcached', name: 'memcache-py' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = scanFileImports(root);
    importsByFile.set(filePath, v);
    return v;
  };

  const ensureTable = (ctx: PyVisitContext, name: string): string => {
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
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') return;
      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute');
      if (!obj || !attr) return;

      const verb = MC_VERBS.get(attr.text);
      if (!verb) return;
      if (!RECEIVER_RE.test(obj.text)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      const keyName = resolveKey(args, ctx, node);
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
        orm: 'memcache-py',
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

function resolveKey(args: SyntaxNode | null, ctx: PyVisitContext, node: SyntaxNode): string {
  if (args) {
    for (let i = 0; i < args.childCount; i++) {
      const c = args.child(i);
      if (!c) continue;
      if (c.type === '(' || c.type === ')' || c.type === ',') continue;
      if (c.type === 'string' || c.type === 'concatenated_string') {
        const s = stripPythonString(c.text);
        if (s !== null) return s;
      }
      // First positional non-string → bail to per-call-site placeholder.
      if (c.type !== 'keyword_argument') break;
    }
  }
  const stem = ctx.sourceFile.filePath.split('/').slice(-1)[0];
  const line = node.startPosition.row + 1;
  return `<dynamic:${stem}:${line}>`;
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

function scanFileImports(root: SyntaxNode): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (!c) continue;
    if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
    if (/\b(pymemcache|memcache)\b/.test(c.text)) return true;
  }
  return false;
}
