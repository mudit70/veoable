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
 * go-elasticsearch visitor.
 *
 * Detection: `<recv>.Verb(...)` where Verb is in ES_VERBS. For
 * `Search`, scan the args for nested `<recv>.Search.WithIndex("name")`
 * calls. For other verbs, take the first string-literal positional
 * arg as the index.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
  // When true, the index is expressed via `.WithIndex("name")` opts.
  // Otherwise the index is the first string-literal arg.
  optionFn: boolean;
}

const ES_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['Index', { op: 'insert', optionFn: false }],
  ['Create', { op: 'insert', optionFn: false }],
  ['Get', { op: 'read', optionFn: false }],
  ['Mget', { op: 'read', optionFn: true }],
  ['Search', { op: 'read', optionFn: true }],
  ['Msearch', { op: 'read', optionFn: true }],
  ['Count', { op: 'read', optionFn: true }],
  ['Update', { op: 'update', optionFn: false }],
  ['Delete', { op: 'delete', optionFn: false }],
  ['Bulk', { op: 'insert', optionFn: true }],
  ['Exists', { op: 'read', optionFn: false }],
]);

export function createElasticGoVisitor(systemId?: string): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'elasticsearch', name: 'elastic-go' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = scanFileImports(root);
    importsByFile.set(filePath, v);
    return v;
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
        kind: 'collection',
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

      const verb = ES_VERBS.get(field.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      let indexName: string | null = null;
      if (args) {
        indexName = verb.optionFn
          ? extractWithIndexFromArgs(args)
          : firstStringArg(args);
      }
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
        orm: 'elastic-go',
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

function firstStringArg(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      return stripGoString(c.text);
    }
    return null;
  }
  return null;
}

/**
 * For `es.Search(es.Search.WithIndex("name"), ...)` — scan the args
 * for nested `WithIndex("...")` calls and return the string-literal
 * value.
 */
function extractWithIndexFromArgs(args: SyntaxNode): string | null {
  const re = /WithIndex\s*\(\s*"([^"]*)"\s*\)/;
  const m = re.exec(args.text);
  return m ? m[1] : null;
}

function stripGoString(text: string): string {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
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

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    if (c.text.includes('github.com/elastic/go-elasticsearch')) return true;
  }
  return false;
}
