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
 * mongodb-rust visitor.
 *
 * Call shape: `<collection>.<verb>(<args>).await?`
 *
 * Collection-name resolution:
 *   1. Per-file scan of `let <var> = <db>.collection::<T>("name")`
 *      and `let <var> = <db>.collection_with_options("name", ...)`
 *      bindings. Maps `<var> → "name"`.
 *   2. Inline `db.collection::<T>("name").find_one(...)` — extract
 *      directly from the receiver chain.
 *
 * Per-file gate: file must `use mongodb` (any path) to enable
 * dispatch. Keeps unrelated `.find` calls on non-mongo receivers
 * (Option::find, Vec::find_map, etc.) from false-positiving.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const MONGO_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['find', { op: 'read' }],
  ['find_one', { op: 'read' }],
  ['find_one_and_delete', { op: 'delete' }],
  ['find_one_and_replace', { op: 'update' }],
  ['find_one_and_update', { op: 'update' }],
  ['count_documents', { op: 'read' }],
  ['estimated_document_count', { op: 'read' }],
  ['distinct', { op: 'read' }],
  ['aggregate', { op: 'read' }],

  ['insert_one', { op: 'insert' }],
  ['insert_many', { op: 'insert' }],

  ['update_one', { op: 'update' }],
  ['update_many', { op: 'update' }],
  ['replace_one', { op: 'update' }],

  ['delete_one', { op: 'delete' }],
  ['delete_many', { op: 'delete' }],
  ['drop', { op: 'delete' }],
]);

export function createMongorustVisitor(systemId: string): RustFrameworkVisitor {
  const emittedTables = new Set<string>();
  const collectionsByFile = new Map<string, Map<string, string>>();
  const importsByFile = new Map<string, boolean>();

  const getCollections = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = collectionsByFile.get(filePath);
    if (!m) {
      m = scanFileForCollectionBindings(root);
      collectionsByFile.set(filePath, m);
    }
    return m;
  };

  const fileImports = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImports(root);
    importsByFile.set(filePath, value);
    return value;
  };

  const ensureCollection = (ctx: RustVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId,
        name,
        schema: null,
        kind: 'collection',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
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

      // Match `<receiver>.<verb>(<args>)` — a field_expression.
      if (fn.type !== 'field_expression') return;
      const fieldName = fn.childForFieldName('field');
      const operand = fn.childForFieldName('value');
      if (!fieldName || !operand) return;

      const methodName = fieldName.text;
      const verb = MONGO_VERBS.get(methodName);
      if (!verb) return;

      const collectionName = resolveCollectionName(
        operand,
        getCollections(ctx.sourceFile.filePath, node.tree.rootNode),
      );
      if (!collectionName) return;
      if (!ctx.enclosingFunction) return;

      const tableId = ensureCollection(ctx, collectionName);
      const operation: DatabaseOperation = toCanonicalOp(verb.op);

      const interaction: DatabaseInteraction = {
        nodeType: 'DatabaseInteraction',
        id: idFor.databaseInteraction({
          callSiteFunctionId: ctx.enclosingFunction.id,
          operation,
          targetTableId: tableId,
        }),
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        orm: 'mongorust',
        rawQuery: null,
        confidence: 'direct',
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: node.startPosition.row + 1,
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
        sourceLine: node.startPosition.row + 1,
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

/**
 * Resolve the collection name from a method-call receiver.
 *
 *   users.find_one(...)                       → bare identifier
 *   self.users.find_one(...)                  → field_expression
 *   db.collection::<T>("users").find_one(...) → inline
 *   db.collection("users").find_one(...)      → inline (no turbofish)
 */
function resolveCollectionName(
  operand: SyntaxNode,
  collections: ReadonlyMap<string, string>,
): string | null {
  if (operand.type === 'identifier') {
    return collections.get(operand.text) ?? null;
  }
  if (operand.type === 'field_expression') {
    // `self.users` — try the full text, then the field name.
    const text = operand.text;
    const cached = collections.get(text);
    if (cached) return cached;
    const fieldName = operand.childForFieldName('field');
    if (fieldName) {
      const collected = collections.get(fieldName.text);
      if (collected) return collected;
    }
    return null;
  }
  // Inline: `db.collection::<T>("name")` returns a Collection so the
  // outer call can chain `.find_one(...)`. tree-sitter-rust wraps the
  // turbofish form as `generic_function` (`db.collection::<T>` →
  // generic_function) and the bare form as `field_expression`.
  if (operand.type === 'call_expression') {
    return resolveCollectionCall(operand);
  }
  return null;
}

/**
 * Inline form: extract the literal string from
 * `<x>.collection::<T>("name")` or `<x>.collection("name")`.
 */
function resolveCollectionCall(callNode: SyntaxNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;

  // Turbofish: `<x>.collection::<T>` parses as generic_function whose
  // function child is a field_expression.
  let fieldExpr: SyntaxNode = fn;
  if (fn.type === 'generic_function') {
    const inner = fn.childForFieldName('function');
    if (!inner || inner.type !== 'field_expression') return null;
    fieldExpr = inner;
  } else if (fn.type !== 'field_expression') {
    return null;
  }

  const fieldName = fieldExpr.childForFieldName('field');
  if (!fieldName) return null;
  if (fieldName.text !== 'collection' && fieldName.text !== 'collection_with_options') {
    return null;
  }

  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  return findFirstStringLiteral(args);
}

/**
 * Per-file scan for collection bindings via `let` statements.
 */
function scanFileForCollectionBindings(rootNode: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'let_declaration') {
      const pattern = n.childForFieldName('pattern');
      const value = n.childForFieldName('value');
      if (pattern && value) {
        const varName = extractLetPatternName(pattern);
        if (varName && value.type === 'call_expression') {
          const collection = resolveCollectionCall(value);
          if (collection) out.set(varName, collection);
        }
        // Handle `let foo = bar.await?;` etc. — peel `try_expression`
        // and `.await` chains? Most binding shapes are direct calls;
        // these chained forms can be added when fixtures need them.
      }
    }
    // Field assignment via assignment_expression (e.g. inside an impl
    // method): `self.events = db.collection::<E>("events");`
    if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right && right.type === 'call_expression') {
        const collection = resolveCollectionCall(right);
        if (collection) {
          const text = left.text;
          out.set(text, collection);
          // Also bind the bare field name (`events`) so
          // `self.events` receiver matches via the field-name fallback.
          if (left.type === 'field_expression') {
            const fieldName = left.childForFieldName('field');
            if (fieldName) out.set(fieldName.text, collection);
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return out;
}

function extractLetPatternName(pattern: SyntaxNode): string | null {
  if (pattern.type === 'identifier') return pattern.text;
  // `let mut foo = ...` wraps the identifier in a mut_pattern.
  if (pattern.type === 'mut_pattern') {
    for (let i = 0; i < pattern.childCount; i++) {
      const c = pattern.child(i);
      if (c && c.type === 'identifier') return c.text;
    }
  }
  return null;
}

function findFirstStringLiteral(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === 'string_literal' || c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') {
      return stripRustStringQuotes(c.text);
    }
  }
  return null;
}

function stripRustStringQuotes(text: string): string | null {
  if (text.startsWith('r#"') && text.endsWith('"#')) return text.slice(3, -2);
  if (text.startsWith('r"') && text.endsWith('"')) return text.slice(2, -1);
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return null;
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  return hasCrateImport(rootNode, 'mongodb');
}
