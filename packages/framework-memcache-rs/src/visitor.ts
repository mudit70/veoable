import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import { hasCrateImport, type RustFrameworkVisitor, type RustVisitContext } from '@adorable/lang-rust';

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const MC_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['get', { op: 'read' }],
  ['gets', { op: 'read' }],
  // Writes
  ['set', { op: 'update' }],
  ['add', { op: 'insert' }],
  ['replace', { op: 'update' }],
  ['append', { op: 'update' }],
  ['prepend', { op: 'update' }],
  ['cas', { op: 'update' }],
  ['increment', { op: 'update' }],
  ['decrement', { op: 'update' }],
  ['touch', { op: 'update' }],
  // Deletes
  ['delete', { op: 'delete' }],
  ['flush', { op: 'delete' }],
  ['flush_with_delay', { op: 'delete' }],
]);

export function createMemcacheRsVisitor(systemId?: string): RustFrameworkVisitor {
  const importsByFile = new Map<string, boolean>();
  const emittedTables = new Set<string>();
  const resolvedSystemId = systemId ?? idFor.databaseSystem({ kind: 'memcached', name: 'memcache-rs' });

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const v = hasCrateImport(root, 'memcache');
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
        kind: 'table',
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
      if (!fn) return;

      let methodName: string | null = null;
      if (fn.type === 'field_expression') {
        methodName = fn.childForFieldName('field')?.text ?? null;
      } else if (fn.type === 'generic_function') {
        // get::<String>(...) — generic_function wraps a field_expression
        const inner = fn.childForFieldName('function');
        if (inner && inner.type === 'field_expression') {
          methodName = inner.childForFieldName('field')?.text ?? null;
        }
      }
      if (!methodName) return;

      const verb = MC_VERBS.get(methodName);
      if (!verb) return;
      if (!ctx.enclosingFunction) return;

      const args = node.childForFieldName('arguments');
      let keyName: string | null = null;
      if (args) keyName = firstStringArg(args);
      // flush()/flush_with_delay()/cas() with no key → sentinel.
      if (keyName === null) {
        if (methodName === 'flush' || methodName === 'flush_with_delay') {
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
        orm: 'memcache-rs',
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
    if (c.type !== 'string_literal' && c.type !== 'raw_string_literal') return null;
    const s = stripRustString(c.text);
    return s;
  }
  return null;
}

function stripRustString(text: string): string | null {
  let s = text;
  if (s.startsWith('b') || s.startsWith('B')) s = s.slice(1);
  if (s.startsWith('r')) {
    const hashes = /^r(#*)"/.exec(s);
    if (hashes) {
      const h = hashes[1].length;
      const closer = '"' + '#'.repeat(h);
      const start = 1 + h + 1;
      if (s.endsWith(closer)) return s.slice(start, s.length - closer.length);
    }
    return null;
  }
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return null;
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
