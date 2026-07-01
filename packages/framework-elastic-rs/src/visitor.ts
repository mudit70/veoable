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
 * elasticsearch (Rust) visitor.
 *
 * Detects `client.<verb>(<Verb>Parts::Variant("index", ...))` calls.
 * The verb is the field name; the index is the first string-literal
 * arg inside the `<Verb>Parts::*` constructor.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const ES_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['index', { op: 'insert' }],
  ['create', { op: 'insert' }],
  ['search', { op: 'read' }],
  ['get', { op: 'read' }],
  ['mget', { op: 'read' }],
  ['exists', { op: 'read' }],
  ['count', { op: 'read' }],
  ['msearch', { op: 'read' }],
  ['delete', { op: 'delete' }],
  ['delete_by_query', { op: 'delete' }],
  ['update', { op: 'update' }],
  ['update_by_query', { op: 'update' }],
  ['bulk', { op: 'insert' }],
]);

export function createElasticRsVisitor(systemId?: string): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-rs' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'elasticsearch');
    importsByFile.set(filePath, v);
    return v;
  };

  const ensureTable = (ctx: RustVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId: resolvedSystemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId: resolvedSystemId,
        name,
        schema: null,
        kind: 'collection',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: resolvedSystemId });
    }
    return tableId;
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'field_expression') return;
      const field = fn.childForFieldName('field');
      if (!field) return;

      const verb = ES_VERBS.get(field.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      if (!args) return;
      const indexName = extractFirstPartsIndex(args);
      if (indexName === null) return;

      const tableId = ensureTable(ctx, indexName);
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
        orm: 'elastic-rs',
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
 * Find the first string literal inside a `<Verb>Parts::Variant("...")`
 * arg. Tolerant of `&[...]` array forms (SearchParts::Index(&["a"]))
 * and (index, id) tuples (GetParts::IndexId("users", "1")).
 */
function extractFirstPartsIndex(args: SyntaxNode): string | null {
  const re = /\w+Parts::\w+\(\s*&?\[?\s*"([^"]+)"/;
  const m = re.exec(args.text);
  return m ? m[1] : null;
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
