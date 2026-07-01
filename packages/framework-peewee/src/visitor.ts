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
 * peewee visitor.
 *
 * Detection: `<ClassName>.<verb>(...)` where ClassName is PascalCase
 * and verb is in MODEL_VERBS. The class name is treated as the
 * DatabaseTable name verbatim.
 *
 * Per-file gate: `import peewee` or `from peewee import ...`.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const MODEL_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['create', { op: 'insert' }],
  ['bulk_create', { op: 'insert' }],
  ['insert', { op: 'insert' }],
  ['insert_many', { op: 'insert' }],
  ['get_or_create', { op: 'insert' }],
  ['select', { op: 'read' }],
  ['raw', { op: 'read' }],
  ['get', { op: 'read' }],
  ['get_by_id', { op: 'read' }],
  ['get_or_none', { op: 'read' }],
  ['filter', { op: 'read' }],
  ['update', { op: 'update' }],
  ['delete', { op: 'delete' }],
  ['delete_by_id', { op: 'delete' }],
  ['truncate_table', { op: 'delete' }],
]);

export function createPeeweeVisitor(systemId?: string): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'other', name: 'peewee' });

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

      const verb = MODEL_VERBS.get(attr.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const receiver = obj.text;
      // Receiver must be a PascalCase identifier — peewee Model class.
      if (!/^[A-Z][A-Za-z0-9_]*$/.test(receiver)) return;
      // Avoid false matches on stdlib types in user code.
      if (BUILTIN_PASCAL.has(receiver)) return;

      const tableId = ensureTable(ctx, receiver);
      const operation: DatabaseOperation = toCanonicalOp(verb.op);
      const evidenceLine = node.startPosition.row + 1;

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'peewee',
        rawQuery: null,
        confidence: 'direct',
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: evidenceLine,
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
        sourceLine: evidenceLine,
      });
    },
  };
}

const BUILTIN_PASCAL: ReadonlySet<string> = new Set([
  'Exception', 'BaseException', 'TypeError', 'ValueError',
  'ArithmeticError', 'OSError', 'IOError', 'FileNotFoundError',
  'Path', 'PurePath',
]);

function toCanonicalOp(op: 'read' | 'insert' | 'update' | 'delete'): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
  }
}

function scanFileImports(root: SyntaxNode): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (!c) continue;
    if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
    if (/\bpeewee\b/.test(c.text)) return true;
  }
  return false;
}
