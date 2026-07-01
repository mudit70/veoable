import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@adorable/lang-go';

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
  // When true, the key is the `Key:` field of a `&memcache.Item{...}`
  // composite literal arg. Otherwise the key is the first string-
  // literal positional arg.
  itemArg: boolean;
}

const MC_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['Get', { op: 'read', itemArg: false }],
  ['GetMulti', { op: 'read', itemArg: false }],
  // Updates (Item-arg shapes)
  ['Set', { op: 'update', itemArg: true }],
  ['Add', { op: 'insert', itemArg: true }],
  ['Replace', { op: 'update', itemArg: true }],
  ['CompareAndSwap', { op: 'update', itemArg: true }],
  // Updates (key-arg shapes)
  ['Increment', { op: 'update', itemArg: false }],
  ['Decrement', { op: 'update', itemArg: false }],
  ['Touch', { op: 'update', itemArg: false }],
  // Deletes
  ['Delete', { op: 'delete', itemArg: false }],
  ['DeleteAll', { op: 'delete', itemArg: false }],
  ['FlushAll', { op: 'delete', itemArg: false }],
]);

export function createMemcacheGoVisitor(systemId?: string): GoFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'memcached', name: 'memcache-go' });

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

      const verb = MC_VERBS.get(field.text);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      let keyName: string | null = null;
      if (args) {
        keyName = verb.itemArg
          ? extractItemKey(args)
          : firstStringArg(args);
      }
      // Verbs without a key (FlushAll/DeleteAll) get a special name.
      if (keyName === null) {
        if (field.text === 'FlushAll' || field.text === 'DeleteAll') {
          keyName = '<flush:all>';
        } else {
          return;
        }
      }

      const tableId = ensureTable(ctx, keyName);
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
        orm: 'memcache-go',
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

function extractItemKey(args: SyntaxNode): string | null {
  // Regex over the args text for the Key field of a composite literal.
  // Same robust pattern that framework-awsgo-s3 uses.
  const re = /\bKey\s*:\s*"([^"]+)"/;
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
    if (c.text.includes('github.com/bradfitz/gomemcache')) return true;
  }
  return false;
}
