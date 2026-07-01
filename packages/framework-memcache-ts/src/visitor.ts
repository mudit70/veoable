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
 * memjs visitor. Mirrors framework-ioredis style: receiver heuristic
 * + per-file `memjs` import gate. Memcached commands aren't as
 * deeply nested as Redis; the key is always the first arg.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const MC_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['get', { op: 'read' }],
  ['stats', { op: 'read' }],

  // Updates
  ['set', { op: 'update' }],
  ['add', { op: 'insert' }],
  ['replace', { op: 'update' }],
  ['append', { op: 'update' }],
  ['prepend', { op: 'update' }],
  ['increment', { op: 'update' }],
  ['decrement', { op: 'update' }],
  ['touch', { op: 'update' }],

  // Deletes
  ['delete', { op: 'delete' }],
  ['flush', { op: 'delete' }],
]);

const RECEIVER_RE = /^(?:self\.)?(?:client|cache|mc|mem|memcache|memcached)$/i;

export function createMemcacheTsVisitor(systemId?: string): TsFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'memcached', name: 'memcache-ts' });

  const fileImports = (node: Node, filePath: string): boolean => {
    if (importsByFile.has(filePath)) return importsByFile.get(filePath)!;
    const sf = node.getSourceFile();
    const has = sf.getImportDeclarations().some((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec === 'memjs' || spec.startsWith('memjs/');
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
      if (!fileImports(node, ctx.sourceFile.filePath)) return;

      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();
      const verb = MC_VERBS.get(methodName);
      if (!verb) return;
      if (!RECEIVER_RE.test(callee.getExpression().getText())) return;
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
        orm: 'memcache-ts',
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
  const stem = ctx.sourceFile.filePath.split('/').slice(-1)[0];
  const line = node.getStartLineNumber();
  return `<dynamic:${stem}:${line}>`;
}
