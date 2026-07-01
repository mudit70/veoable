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

const MODEL_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['create', { op: 'insert' }],
  ['bulk_create', { op: 'insert' }],
  ['update_or_create', { op: 'insert' }],
  ['get_or_create', { op: 'insert' }],
  ['get', { op: 'read' }],
  ['get_or_none', { op: 'read' }],
  ['filter', { op: 'read' }],
  ['exclude', { op: 'read' }],
  ['all', { op: 'read' }],
  ['first', { op: 'read' }],
  ['exists', { op: 'read' }],
  ['count', { op: 'read' }],
  // update / delete on a queryset
  ['update', { op: 'update' }],
  ['delete', { op: 'delete' }],
  ['bulk_update', { op: 'update' }],
]);

const BUILTIN_PASCAL: ReadonlySet<string> = new Set([
  'Exception', 'BaseException', 'TypeError', 'ValueError',
  'Path', 'PurePath', 'Optional', 'List', 'Dict', 'Tuple',
  'Set', 'Enum', 'NamedTuple', 'Iterator', 'Awaitable',
]);

export function createTortoiseVisitor(systemId?: string): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'other', name: 'tortoise' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    let has = false;
    for (let i = 0; i < root.childCount; i++) {
      const c = root.child(i);
      if (!c) continue;
      if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
      if (/\btortoise\b/.test(c.text)) { has = true; break; }
    }
    importsByFile.set(filePath, has);
    return has;
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

      // Receiver can be `User` (Model class) OR `User.filter(...)` (queryset).
      // Walk down the leftmost call chain to find the root PascalCase name.
      const rootName = findRootPascalReceiver(obj);
      if (!rootName) return;
      if (BUILTIN_PASCAL.has(rootName)) return;

      const tableId = ensureTable(ctx, rootName);
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
        orm: 'tortoise',
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

/**
 * Walk down `<root>.<method>(...)...<method>(...)` chains to find the
 * leftmost identifier. Used so `User.filter(...).update(...)` attributes
 * the update to `User`.
 */
function findRootPascalReceiver(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node;
  let depth = 0;
  while (cur && depth < 32) {
    depth++;
    if (cur.type === 'identifier') {
      const text = cur.text;
      return /^[A-Z][A-Za-z0-9_]*$/.test(text) ? text : null;
    }
    if (cur.type === 'attribute') {
      cur = cur.childForFieldName('object');
      continue;
    }
    if (cur.type === 'call') {
      const fn = cur.childForFieldName('function');
      if (!fn) return null;
      cur = fn.type === 'attribute' ? fn.childForFieldName('object') : fn;
      continue;
    }
    return null;
  }
  return null;
}

function toCanonicalOp(op: 'read' | 'insert' | 'update' | 'delete'): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
  }
}
