import { Node, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph';
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import {
  buildEvidence,
  readStringLiteral,
  type TsFrameworkVisitor,
  type TsVisitContext,
} from '@veoable/lang-ts';

/**
 * @elastic/elasticsearch visitor.
 *
 * Detection: `<client>.<verb>({ index: 'X', ... })` where `<verb>` is
 * in the ES_VERBS map. The first arg's object literal must have a
 * string-literal `index` property — otherwise the table is dynamic.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const ES_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['index', { op: 'insert' }],
  ['search', { op: 'read' }],
  ['get', { op: 'read' }],
  ['mget', { op: 'read' }],
  ['exists', { op: 'read' }],
  ['count', { op: 'read' }],
  ['msearch', { op: 'read' }],
  ['delete', { op: 'delete' }],
  ['deleteByQuery', { op: 'delete' }],
  ['update', { op: 'update' }],
  ['updateByQuery', { op: 'update' }],
  ['bulk', { op: 'insert' }],
  ['create', { op: 'insert' }],
  ['reindex', { op: 'insert' }],
]);

const RECEIVER_RE = /^(?:self\.)?(?:client|es|elastic|elasticsearch|esClient|esc)$/i;

export function createElasticTsVisitor(systemId?: string): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-ts' });

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === '@elastic/elasticsearch' || spec.startsWith('@elastic/elasticsearch/');
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
        kind: 'collection',
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
      if (!fileImports(node, ctx.sourceFile.filePath)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();
      const verb = ES_VERBS.get(methodName);
      if (!verb) return;

      const receiverText = callee.getExpression().getText();
      if (!RECEIVER_RE.test(receiverText)) return;
      if (!ctx.enclosingFunction) return;

      const args = node.getArguments();
      const opts = args[0];
      if (!opts || !Node.isObjectLiteralExpression(opts)) return;
      const indexName = readIndexProperty(opts);
      if (indexName === null) return;

      const tableId = ensureTable(ctx, indexName);
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
        orm: 'elastic-ts',
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

function readIndexProperty(obj: ObjectLiteralExpression): string | null {
  const prop = obj.getProperty('index');
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return null;
  return readStringLiteral(init);
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
