import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';

/**
 * SQLModel visitor.
 *
 * Detection paths:
 *
 * 1. `select(<Entity>)`  → read on Entity.
 * 2. `<session>.get(<Entity>, ...)` → read on Entity.
 * 3. `<session>.add(<Entity>(...))` → insert on Entity.
 * 4. `<session>.merge(<Entity>(...))` → update on Entity.
 *
 * Per-file gate: `import sqlmodel` / `from sqlmodel import ...`.
 */

const BUILTIN_PASCAL: ReadonlySet<string> = new Set([
  'Exception', 'BaseException', 'TypeError', 'ValueError',
  'Path', 'PurePath', 'Optional', 'List', 'Dict', 'Tuple',
  'Set', 'Enum', 'NamedTuple', 'Iterator', 'Awaitable',
  'Sequence', 'Session', 'AsyncSession', 'Engine', 'Field',
  'SQLModel', 'Column', 'Type',
]);

export function createSqlmodelVisitor(systemId?: string): PyFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'other', name: 'sqlmodel' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    let has = false;
    for (let i = 0; i < root.childCount; i++) {
      const c = root.child(i);
      if (!c) continue;
      if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
      if (/\bsqlmodel\b/.test(c.text)) { has = true; break; }
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

  const emit = (
    ctx: PyVisitContext,
    node: SyntaxNode,
    op: 'read' | 'insert' | 'update' | 'delete',
    tableName: string,
  ): void => {
    if (!ctx.enclosingFunction) return;
    const operation: DatabaseOperation = toCanonicalOp(op);
    const tableId = ensureTable(ctx, tableName);
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
      orm: 'sqlmodel',
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
  };

  return {
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // Path 1: select(<Entity>)
      if (fn.type === 'identifier' && fn.text === 'select') {
        const args = node.childForFieldName('arguments');
        if (!args) return;
        const entity = firstPascalArg(args);
        if (entity) emit(ctx, node, 'read', entity);
        return;
      }

      // Paths 2-4: <session>.<verb>(...)
      if (fn.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        if (!attr) return;
        const verb = attr.text;
        const args = node.childForFieldName('arguments');
        if (!args) return;

        if (verb === 'get') {
          const entity = firstPascalArg(args);
          if (entity) emit(ctx, node, 'read', entity);
          return;
        }

        if (verb === 'add' || verb === 'merge') {
          // First arg should be `<Entity>(...)` constructor call.
          const ctor = firstCtorClassName(args);
          if (ctor) emit(ctx, node, verb === 'add' ? 'insert' : 'update', ctor);
          return;
        }
      }
    },
  };
}

function firstPascalArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    if (c.type === 'identifier') {
      if (/^[A-Z][A-Za-z0-9_]*$/.test(c.text) && !BUILTIN_PASCAL.has(c.text)) return c.text;
      return null;
    }
    return null;
  }
  return null;
}

function firstCtorClassName(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'keyword_argument') continue;
    if (c.type === 'call') {
      const fn = c.childForFieldName('function');
      if (fn && fn.type === 'identifier') {
        if (/^[A-Z][A-Za-z0-9_]*$/.test(fn.text) && !BUILTIN_PASCAL.has(fn.text)) return fn.text;
      }
      return null;
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
