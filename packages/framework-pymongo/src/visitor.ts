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
 * PyMongo visitor.
 *
 * MongoDB call shape:
 *   <collection>.<verb>(<args>)
 *
 * Where `<collection>` is one of:
 *   db['users']
 *   db.users
 *   self.users
 *   db.get_collection('users')   ← rare, deferred
 *
 * Detection:
 *   1. Per-file scan for assignments that look like collection
 *      bindings:
 *        users = db['users']             → { users: 'users' }
 *        users = db.users                → { users: 'users' }
 *        users = client['mydb']['users'] → { users: 'users' }
 *   2. On any `call` whose function is `<recv>.<verb>` where verb is
 *      in PYMONGO_VERBS:
 *        - If recv is a bare identifier in the collection map → use
 *          that collection name.
 *        - If recv is `<x>.<name>` or `<x>['name']` → use `<name>`
 *          as the collection name directly.
 *
 * Conservative v1:
 *   - `db.get_collection('x')` is not detected; rare in real code.
 *   - Cross-file collection bindings aren't traced.
 *   - Bulk operations via `bulk_write` and `with_options` chains
 *     pass through the underlying CRUD methods, which we DO detect.
 */

interface VerbInfo {
  op: 'read' | 'insert' | 'update' | 'delete';
}

const PYMONGO_VERBS: ReadonlyMap<string, VerbInfo> = new Map([
  // Reads
  ['find', { op: 'read' }],
  ['find_one', { op: 'read' }],
  ['find_one_and_delete', { op: 'delete' }],  // returns + deletes
  ['find_one_and_replace', { op: 'update' }],
  ['find_one_and_update', { op: 'update' }],
  ['count_documents', { op: 'read' }],
  ['estimated_document_count', { op: 'read' }],
  ['distinct', { op: 'read' }],
  ['aggregate', { op: 'read' }],

  // Writes (insert)
  ['insert_one', { op: 'insert' }],
  ['insert_many', { op: 'insert' }],

  // Writes (update)
  ['update_one', { op: 'update' }],
  ['update_many', { op: 'update' }],
  ['replace_one', { op: 'update' }],

  // Writes (delete)
  ['delete_one', { op: 'delete' }],
  ['delete_many', { op: 'delete' }],
  ['drop', { op: 'delete' }],
]);

export function createPymongoVisitor(systemId: string): PyFrameworkVisitor {
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

  const fileImportsPymongo = (filePath: string, root: SyntaxNode): boolean => {
    const cached = importsByFile.get(filePath);
    if (cached !== undefined) return cached;
    const value = scanFileImports(root);
    importsByFile.set(filePath, value);
    return value;
  };

  const ensureCollection = (ctx: PyVisitContext, name: string): string => {
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
    language: 'py',
    onNode(ctx, node) {
      if (node.type !== 'call') return;
      if (!fileImportsPymongo(ctx.sourceFile.filePath, node.tree.rootNode)) return;

      const fn = node.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') return;

      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute');
      if (!obj || !attr) return;

      const verb = PYMONGO_VERBS.get(attr.text);
      if (!verb) return;

      const collectionName = resolveCollectionName(
        obj,
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
        orm: 'pymongo',
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
 * Resolve the collection name from a method-call receiver:
 *
 *   db['users'].find(...)             → 'users' (subscript with string)
 *   db.users.find(...)                → 'users' (attribute access)
 *   self.users_coll.find(...)         → from per-file binding map
 *   client['mydb']['users'].find(...) → 'users' (nested subscript)
 *   users.find(...)                   → from per-file binding map
 */
function resolveCollectionName(
  obj: SyntaxNode,
  collections: ReadonlyMap<string, string>,
): string | null {
  // Subscript form: db['users']
  if (obj.type === 'subscript') {
    const subscript = obj.childForFieldName('subscript');
    if (subscript && subscript.type === 'string') {
      return stripPythonString(subscript.text);
    }
    return null;
  }
  // Attribute form: db.users
  if (obj.type === 'attribute') {
    const attrName = obj.childForFieldName('attribute');
    if (attrName) {
      const text = attrName.text;
      // `db.users.find(...)` — the LAST attribute is the collection
      // name. Reject `find_one`-like calls accidentally caught.
      if (PYMONGO_VERBS.has(text)) return null;
      return text;
    }
    return null;
  }
  // Bare identifier: users.find(...) — consult per-file binding map
  if (obj.type === 'identifier') {
    return collections.get(obj.text) ?? null;
  }
  return null;
}

/**
 * Scan top-level + class-body assignments for collection bindings.
 *
 *   users = db['users']
 *   users = db.users
 *   self.users = db['users']  (inside __init__)
 *
 * Returns a map of `<var name> → <collection name>`.
 */
function scanFileForCollectionBindings(rootNode: SyntaxNode): Map<string, string> {
  // Pass A — find every identifier bound to a Mongo client OR database.
  // Without this pass, `db = client['mydb']` would bind `db → 'mydb'`
  // as a collection. Subsequent `db.aggregate(...)` calls (a valid
  // pymongo Database method) would emit a phantom 'mydb' collection
  // interaction.
  const databases = identifyDatabaseIdentifiers(rootNode);

  // Pass B — collection bindings on receivers in the database set.
  const out = new Map<string, string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right) {
        const varName = extractAssignedName(left);
        const collectionName = resolveCollectionRhs(right, databases);
        if (varName && collectionName) out.set(varName, collectionName);
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

const CLIENT_NAME_RE = /(?:^|_)client$|client$/i;

/**
 * First-pass scan — find every identifier bound to a Mongo client or
 * database. Returns the set of identifiers that hold DATABASES.
 *
 * Identifies clients via:
 *   client = MongoClient(...)         (constructor)
 *   client = pymongo.MongoClient(...)
 *   <name>                            (name heuristic — ends in `client`)
 *
 * Then chains to databases via:
 *   db = client['mydb']
 *   db = client.mydb
 *   db = client.get_database('mydb')
 *
 * Conventional `db`/`database` names always treated as databases too
 * (covers cross-file imports).
 */
function identifyDatabaseIdentifiers(rootNode: SyntaxNode): Set<string> {
  const clients = new Set<string>();
  const databases = new Set<string>(['db', 'database', 'mongo_db', 'mongodb']);

  const walk = (n: SyntaxNode): void => {
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left && right) {
        const varName = extractAssignedName(left);
        if (varName) {
          if (CLIENT_NAME_RE.test(varName)) clients.add(varName);
          if (isClientConstructorRhs(right)) clients.add(varName);
          if (isDatabaseRhs(right, clients)) databases.add(varName);
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(rootNode);
  return databases;
}

function isClientConstructorRhs(rhs: SyntaxNode): boolean {
  if (rhs.type !== 'call') return false;
  const fn = rhs.childForFieldName('function');
  if (!fn) return false;
  if (fn.type === 'identifier') return /Client$/.test(fn.text);
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr ? /Client$/.test(attr.text) : false;
  }
  return false;
}

function isDatabaseRhs(rhs: SyntaxNode, clients: ReadonlySet<string>): boolean {
  if (rhs.type === 'subscript') {
    const obj = rhs.childForFieldName('value');
    if (obj && obj.type === 'identifier' && clients.has(obj.text)) return true;
    return false;
  }
  if (rhs.type === 'attribute') {
    const obj = rhs.childForFieldName('object');
    const attr = rhs.childForFieldName('attribute');
    if (!obj || !attr) return false;
    if (obj.type === 'identifier' && clients.has(obj.text)) {
      return !PYMONGO_VERBS.has(attr.text);
    }
    return false;
  }
  if (rhs.type === 'call') {
    const fn = rhs.childForFieldName('function');
    if (fn && fn.type === 'attribute') {
      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute');
      if (obj && attr && obj.type === 'identifier' && clients.has(obj.text) && attr.text === 'get_database') {
        return true;
      }
    }
  }
  return false;
}

function extractAssignedName(left: SyntaxNode): string | null {
  if (left.type === 'identifier') return left.text;
  // `self.users` → 'users' (so visiting the attribute receiver
  // later as `self.users` resolves correctly via the bare attribute
  // path, not the binding map; but we still emit so the bare-id
  // case finds it).
  if (left.type === 'attribute') {
    const attrName = left.childForFieldName('attribute');
    return attrName?.text ?? null;
  }
  return null;
}

/**
 * Resolve a RHS to a collection name when the RHS chains off a known
 * DATABASE receiver. Handles:
 *
 *   db['users']                  → 'users'        (db is in `databases`)
 *   db.users                     → 'users'
 *   client['mydb']['users']      → 'users'        (nested subscript;
 *                                                    inner subscript's
 *                                                    receiver is a
 *                                                    client → middle is
 *                                                    a database)
 *   client['mydb'].users         → 'users'
 *   client['mydb']               → null           (RHS is a database,
 *                                                    not a collection)
 *   get_database(...)            → null
 */
function resolveCollectionRhs(rhs: SyntaxNode, databases: ReadonlySet<string>): string | null {
  if (rhs.type === 'subscript') {
    const obj = rhs.childForFieldName('value');
    const subscript = rhs.childForFieldName('subscript');
    if (!obj || !subscript || subscript.type !== 'string') return null;
    // db['users'] — `db` is in the database set.
    if (obj.type === 'identifier' && databases.has(obj.text)) {
      return stripPythonString(subscript.text);
    }
    // client['mydb']['users'] — outer obj is a subscript whose own
    // receiver is treated as a client (any identifier; this nested
    // form is unambiguous).
    if (obj.type === 'subscript') {
      const innerObj = obj.childForFieldName('value');
      const innerSubscript = obj.childForFieldName('subscript');
      if (innerObj?.type === 'identifier' && innerSubscript?.type === 'string') {
        return stripPythonString(subscript.text);
      }
    }
    return null;
  }
  if (rhs.type === 'attribute') {
    const obj = rhs.childForFieldName('object');
    const attrName = rhs.childForFieldName('attribute');
    if (!obj || !attrName) return null;
    const text = attrName.text;
    if (PYMONGO_VERBS.has(text)) return null;
    // db.users — `db` is in the database set.
    if (obj.type === 'identifier' && databases.has(obj.text)) return text;
    // client['mydb'].users — same unambiguous nested form.
    if (obj.type === 'subscript') {
      const innerObj = obj.childForFieldName('value');
      const innerSubscript = obj.childForFieldName('subscript');
      if (innerObj?.type === 'identifier' && innerSubscript?.type === 'string') {
        return text;
      }
    }
    return null;
  }
  return null;
}

function stripPythonString(text: string): string | null {
  let s = text;
  if (/^[rRbBuU]*[fF]/.test(s)) return null;
  s = s.replace(/^[rRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return null;
}

function scanFileImports(rootNode: SyntaxNode): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (c.type !== 'import_statement' && c.type !== 'import_from_statement') continue;
    const text = c.text;
    if (text.includes('pymongo') || text.includes('motor')) return true;
  }
  return false;
}
