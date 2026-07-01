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
 * Ent visitor.
 *
 * Detection: `<client>.<EntityName>.<Method>(...)` where Method is
 * one of Create / Query / Update / Delete / Get / CreateBulk /
 * DeleteOne / UpdateOne / UpdateOneID / DeleteOneID / QueryX / GetX.
 *
 * Entity is the table-equivalent. We use the entity name verbatim
 * as the DatabaseTable name.
 *
 * Per-file gate: file must `import` a path that includes `/ent` or
 * `entgo.io/ent`. Activation-level gate is `entgo.io/ent` in go.mod.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const ENT_METHODS: ReadonlyMap<string, VerbInfo> = new Map([
  ['Create', { op: 'insert' }],
  ['CreateBulk', { op: 'insert' }],
  ['Query', { op: 'read' }],
  ['QueryX', { op: 'read' }],
  ['Get', { op: 'read' }],
  ['GetX', { op: 'read' }],
  ['Update', { op: 'update' }],
  ['UpdateOne', { op: 'update' }],
  ['UpdateOneID', { op: 'update' }],
  ['Delete', { op: 'delete' }],
  ['DeleteOne', { op: 'delete' }],
  ['DeleteOneID', { op: 'delete' }],
]);

export function createEntVisitor(systemId?: string): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'other', name: 'ent' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    let has = false;
    for (let i = 0; i < root.childCount; i++) {
      const c = root.child(i);
      if (!c || c.type !== 'import_declaration') continue;
      const t = c.text;
      if (t.includes('entgo.io/ent') || /["']\S+\/ent["']/.test(t)) {
        has = true;
        break;
      }
    }
    importsByFile.set(filePath, has);
    return has;
  };

  const ensureTable = (ctx: GoVisitContext, name: string): string => {
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
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;
      const field = fn.childForFieldName('field');
      if (!field) return;

      const verb = ENT_METHODS.get(field.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      // The operand chain is `client.User` (selector_expression).
      const operand = fn.childForFieldName('operand');
      if (!operand || operand.type !== 'selector_expression') return;
      const entityField = operand.childForFieldName('field');
      if (!entityField) return;
      const entityName = entityField.text;
      // Entity names are PascalCase; cheap guard against false matches.
      if (!/^[A-Z][A-Za-z0-9_]*$/.test(entityName)) return;
      // Don't treat the client receiver itself as an entity.
      if (entityName === 'Client') return;

      const tableId = ensureTable(ctx, entityName);
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
        orm: 'ent',
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

function toCanonicalOp(op: 'read' | 'insert' | 'update' | 'delete'): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
    default: return 'read';
  }
}
