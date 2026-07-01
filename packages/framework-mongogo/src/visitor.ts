import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import type { GoFrameworkVisitor, GoVisitContext } from '@veoable/lang-go';
import type { CollectionHelperMap } from './helpers-resolver.js';

/**
 * mongo-go-driver visitor.
 *
 * Call shape: `<collection>.<Verb>(<args>)`
 *
 * Collection name resolution:
 *   1. Per-file scan for variable bindings:
 *        users := db.Collection("users")
 *        var users = db.Collection("users")
 *      → `users` → "users".
 *   2. Direct method-call on a `db.Collection("name")` expression
 *      (rare in practice but covered).
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const MONGOGO_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  ['Find', { op: 'read' }],
  ['FindOne', { op: 'read' }],
  ['FindOneAndDelete', { op: 'delete' }],
  ['FindOneAndReplace', { op: 'update' }],
  ['FindOneAndUpdate', { op: 'update' }],
  ['CountDocuments', { op: 'read' }],
  ['EstimatedDocumentCount', { op: 'read' }],
  ['Distinct', { op: 'read' }],
  ['Aggregate', { op: 'read' }],

  ['InsertOne', { op: 'insert' }],
  ['InsertMany', { op: 'insert' }],

  ['UpdateOne', { op: 'update' }],
  ['UpdateMany', { op: 'update' }],
  ['UpdateByID', { op: 'update' }],
  ['ReplaceOne', { op: 'update' }],

  ['DeleteOne', { op: 'delete' }],
  ['DeleteMany', { op: 'delete' }],
  ['Drop', { op: 'delete' }],
]);

export function createMongogoVisitor(
  systemId: string,
  helperMap?: CollectionHelperMap,
): GoFrameworkVisitor {
  const emittedTables = new Set<string>();
  const collectionsByFile = new Map<string, Map<string, string>>();
  const importsByFile = new Map<string, boolean>();
  const helpers = helperMap?.byFunctionName ?? new Map<string, string>();

  const getCollections = (filePath: string, root: SyntaxNode): Map<string, string> => {
    let m = collectionsByFile.get(filePath);
    if (!m) {
      m = scanFileForCollectionBindings(root, helpers);
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

  const ensureCollection = (ctx: GoVisitContext, name: string): string => {
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
    language: 'go',
    onNode(ctx, node) {
      if (node.type !== 'call_expression') return;
      if (!fileImports(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') return;

      const field = fn.childForFieldName('field');
      const operand = fn.childForFieldName('operand');
      if (!field || !operand) return;

      const methodName = field.text;
      const verb = MONGOGO_VERBS.get(methodName);
      if (!verb) return;

      const collectionName = resolveCollectionName(
        operand,
        getCollections(ctx.sourceFile.filePath, node.tree.rootNode),
        helpers,
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
        orm: 'mongogo',
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
 *   users.FindOne(ctx, ...)             → 'users' (via bindings)
 *   s.users.FindOne(ctx, ...)           → look up `s.users` text in bindings
 *   db.Collection("users").FindOne(...) → 'users' (inline)
 */
function resolveCollectionName(
  operand: SyntaxNode,
  collections: ReadonlyMap<string, string>,
  helpers: ReadonlyMap<string, string>,
): string | null {
  // Bare identifier: users.FindOne(...)
  if (operand.type === 'identifier') {
    return collections.get(operand.text) ?? null;
  }
  // Selector: s.users.FindOne(...) — `s.users` as a key
  if (operand.type === 'selector_expression') {
    const text = operand.text;
    const cached = collections.get(text);
    if (cached) return cached;
    // Fall back to the field name directly
    const field = operand.childForFieldName('field');
    if (field) {
      const collected = collections.get(field.text);
      if (collected) return collected;
    }
    return null;
  }
  // Inline: db.Collection("users").FindOne(...) — operand is a
  // call_expression. First try the existing direct-collection-call
  // shape, then fall back to the cross-file helper map.
  if (operand.type === 'call_expression') {
    const direct = resolveCollectionCall(operand);
    if (direct) return direct;
    return resolveCallViaHelpers(operand, helpers);
  }
  return null;
}

/**
 * Resolve calls like `db.Vehicles(client)` or `Vehicles(client)` to
 * their target collection name via the cross-file helper map.
 *
 * Strategy:
 *   - Bare function: `Vehicles(c)`        → look up "Vehicles"
 *   - Selector:      `db.Vehicles(c)`     → look up the trailing field
 *   - Method:        `s.Vehicles(c)`      → look up the trailing field
 */
function resolveCallViaHelpers(
  callNode: SyntaxNode,
  helpers: ReadonlyMap<string, string>,
): string | null {
  if (helpers.size === 0) return null;
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') {
    return helpers.get(fn.text) ?? null;
  }
  if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    if (field) return helpers.get(field.text) ?? null;
  }
  return null;
}

/**
 * Recognize `<x>.Collection("name")` and return "name".
 */
function resolveCollectionCall(callNode: SyntaxNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return null;
  const field = fn.childForFieldName('field');
  if (field?.text !== 'Collection') return null;
  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  return readStringLiteralArg(args, 0);
}

/**
 * Scan top-level + function-body statements for variable bindings
 * of the shape:
 *
 *   users := db.Collection("users")
 *   var users = db.Collection("users")
 *   users := client.Database("db").Collection("users")
 *   s.users = db.Collection("users")
 *
 * Returns a map of `<var or selector text> → <collection name>`.
 */
function scanFileForCollectionBindings(
  rootNode: SyntaxNode,
  helpers: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right) {
        const lefts = expressionListChildren(left);
        const rights = expressionListChildren(right);
        // Pair up left[i] with right[i]; mongo bindings are usually
        // simple 1-to-1.
        for (let i = 0; i < Math.min(lefts.length, rights.length); i++) {
          const name = lefts[i].text;
          const collection = resolveCollectionRhs(rights[i], helpers);
          if (collection) out.set(name, collection);
        }
      }
    }
    // `var foo = expr` and `var (foo = expr; bar = expr)` go through
    // var_declaration → var_spec children.
    if (n.type === 'var_spec') {
      const name = n.childForFieldName('name');
      const value = n.childForFieldName('value');
      if (name && value) {
        const valueList = expressionListChildren(value);
        if (valueList.length > 0) {
          const collection = resolveCollectionRhs(valueList[0], helpers);
          if (collection) out.set(name.text, collection);
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

function expressionListChildren(node: SyntaxNode): SyntaxNode[] {
  if (node.type === 'expression_list') {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c) continue;
      if (c.type === ',') continue;
      out.push(c);
    }
    return out;
  }
  return [node];
}

function resolveCollectionRhs(
  rhs: SyntaxNode,
  helpers: ReadonlyMap<string, string>,
): string | null {
  if (rhs.type === 'call_expression') {
    const direct = resolveCollectionCall(rhs);
    if (direct) return direct;
    return resolveCallViaHelpers(rhs, helpers);
  }
  return null;
}

function nthArg(args: SyntaxNode, index: number): SyntaxNode | null {
  let seen = 0;
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (!c) continue;
    if (c.type === '(' || c.type === ')' || c.type === ',') continue;
    if (seen === index) return c;
    seen++;
  }
  return null;
}

function readStringLiteralArg(args: SyntaxNode, index: number): string | null {
  const arg = nthArg(args, index);
  if (!arg) return null;
  if (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal') {
    return arg.text.slice(1, -1);
  }
  return null;
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_declaration') continue;
    if (c.text.includes('mongo-driver')) return true;
  }
  return false;
}
