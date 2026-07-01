import { Node, type CallExpression } from 'ts-morph';
import {
  idFor,
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@veoable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveNamespaceImportProperty,
} from '@veoable/lang-ts';

/**
 * Drizzle visitor (#365). Two extraction surfaces share the same
 * lang-ts walk:
 *
 * 1. **Schema discovery** — `pgTable('users', { ... })`,
 *    `mysqlTable(...)`, `sqliteTable(...)` calls emit
 *    `DatabaseTable` + `DatabaseColumn` (one per shape property).
 *
 * 2. **Receiver detection** — `<recv>.<verb>(...)` fluent builder:
 *    - `db.select().from(usersTable)` → table from `.from(table)`
 *    - `db.insert(usersTable).values(...)` → first-arg table
 *    - `db.update(usersTable).set(...)` → same
 *    - `db.delete(usersTable).where(...)` → same
 *    - `db.query.users.findFirst(...)` → relational API (TBD —
 *      table from the second segment of the access chain)
 *    - `db.execute(sql\`...\`)` → operation 'raw', confidence dynamic
 *
 *    Receivers `db`, `database`, `drizzle`, `this.db`, `this.drizzle`,
 *    or anything ending in `Db`/`Drizzle` are accepted.
 */

const SCHEMA_DECLARATION_FNS: ReadonlySet<string> = new Set([
  'pgTable', 'mysqlTable', 'sqliteTable',
]);

const READ_VERBS: ReadonlySet<string> = new Set(['select']);
const WRITE_VERBS: ReadonlySet<string> = new Set(['insert']);
const UPDATE_VERBS: ReadonlySet<string> = new Set(['update']);
const DELETE_VERBS: ReadonlySet<string> = new Set(['delete']);
const RAW_VERBS: ReadonlySet<string> = new Set(['execute']);

const DB_RECEIVER_RE = /^(?:this\.)?(db|database|drizzle|.*Db|.*Drizzle)$/;

interface TableInfo {
  /** The string passed to `pgTable('name', ...)`. */
  tableName: string;
  declaredIn: string | null;
}

export function createDrizzleVisitor(systemId: string): TsFrameworkVisitor {
  const emittedTables = new Set<string>();
  const emittedColumns = new Set<string>();
  /** Map from a Drizzle table identifier (e.g. `usersTable`) to the string passed to `pgTable('name', ...)`. */
  const tableNameByIdentifier = new Map<string, TableInfo>();

  return {
    language: 'ts',
    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression();

      // #365 — schema discovery from pgTable/mysqlTable/sqliteTable.
      if (Node.isIdentifier(callee) && SCHEMA_DECLARATION_FNS.has(callee.getText())) {
        handleTableDecl(node, ctx, systemId, emittedTables, emittedColumns, tableNameByIdentifier);
        return;
      }

      if (!ctx.enclosingFunction) return;

      // #365 — receiver detection (fluent + first-arg).
      if (!Node.isPropertyAccessExpression(callee)) return;
      const methodName = callee.getNameNode().getText();
      const receiver = callee.getExpression();
      const isDbReceiver = isDrizzleReceiver(receiver);
      const isFluentTail = isFluentChainTail(callee);
      if (!isDbReceiver && !isFluentTail) return;

      let operation: DatabaseOperation | null = null;
      if (methodName === 'from' && isFluentTail) operation = 'read';
      else if (WRITE_VERBS.has(methodName)) operation = 'write';
      else if (UPDATE_VERBS.has(methodName)) operation = 'update';
      else if (DELETE_VERBS.has(methodName)) operation = 'delete';
      else if (RAW_VERBS.has(methodName)) operation = 'raw';
      else return;

      // Find the target table identifier.
      const tableIdent = findTableArgument(node, methodName);
      if (!tableIdent && operation !== 'raw') return;

      const tableName = tableIdent
        ? resolveTableName(tableIdent, tableNameByIdentifier)
        : null;
      if (operation === 'raw') {
        // db.execute(sql`...`) — emit a raw interaction with no
        // specific table target (dynamic). Skip the table emission.
        emitInteraction(ctx, systemId, null, operation, 'dynamic', node);
        return;
      }
      if (!tableName) return;

      const tableId = ensureTable(ctx, systemId, tableName, null, emittedTables);
      emitInteraction(ctx, systemId, tableId, operation, 'direct', node);
    },
  };
}

function isDrizzleReceiver(receiver: Node, visited: Set<Node> = new Set()): boolean {
  if (DB_RECEIVER_RE.test(receiver.getText())) return true;
  // #387 — `db.transaction(async (tx) => tx.insert(...))` binds the
  // callback parameter to the same drizzle client. Recognise the
  // parameter as a drizzle receiver by walking to its declaration
  // and validating the surrounding shape.
  if (Node.isIdentifier(receiver)) {
    return isTransactionCallbackParam(receiver, visited);
  }
  return false;
}

function isTransactionCallbackParam(
  ident: import('ts-morph').Identifier,
  visited: Set<Node> = new Set(),
): boolean {
  // #400 — guard against cyclic resolution. Nested-transaction
  // recursion eventually walks back up to a `db`-named receiver
  // matching DB_RECEIVER_RE, but pathological code (e.g. a parameter
  // whose symbol resolves to itself through a re-export chain)
  // could otherwise loop indefinitely.
  if (visited.has(ident)) return false;
  visited.add(ident);
  const sym = ident.getSymbol();
  if (!sym) return false;
  for (const decl of sym.getDeclarations()) {
    if (!Node.isParameterDeclaration(decl)) continue;
    const fn = decl.getParent();
    if (!fn || (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn))) continue;
    const call = fn.getParent();
    if (!call || !Node.isCallExpression(call)) continue;
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getNameNode().getText() !== 'transaction') continue;
    const outerReceiver = callee.getExpression();
    // #400 — recurse on the outer receiver so nested savepoint
    // patterns (`tx.transaction(async (tx2) => tx2.insert(...))`)
    // resolve. The flat `DB_RECEIVER_RE.test` we used previously
    // only caught one level. The shared `visited` set keeps the
    // recursion bounded.
    if (isDrizzleReceiver(outerReceiver, visited)) return true;
  }
  return false;
}

/**
 * Heuristic: a call like `<...>.from(...)` / `.values(...)` / `.where(...)`
 * is the tail of a fluent chain — accept the call as drizzle when the
 * outer chain starts with a recognised drizzle receiver. We only do
 * this for `.from(<table>)` because that's where the table identifier
 * lives in the SELECT path.
 */
function isFluentChainTail(callee: import('ts-morph').PropertyAccessExpression): boolean {
  if (callee.getNameNode().getText() !== 'from') return false;
  // Walk down the chain to find the head.
  let head: Node = callee.getExpression();
  while (Node.isCallExpression(head) || Node.isPropertyAccessExpression(head)) {
    if (Node.isCallExpression(head)) {
      head = head.getExpression();
      continue;
    }
    head = (head as import('ts-morph').PropertyAccessExpression).getExpression();
  }
  if (DB_RECEIVER_RE.test(head.getText())) return true;
  // #387 — also accept when the chain head is a transaction-callback
  // parameter (e.g. `tx.select().from(users)`).
  if (Node.isIdentifier(head) && isTransactionCallbackParam(head)) return true;
  return false;
}

function findTableArgument(call: CallExpression, _methodName: string): Node | null {
  // For all emit points (`.from()`, `insert()`, `update()`, `delete()`)
  // the table identifier is the first argument of that call.
  const args = call.getArguments();
  if (args.length === 0) return null;
  return args[0];
}

function resolveTableName(
  ident: Node,
  tableNameByIdentifier: Map<string, TableInfo>,
): string | null {
  // Try the local map first.
  const text = ident.getText();
  const local = tableNameByIdentifier.get(text);
  if (local) return local.tableName;
  // Fall back to the identifier text itself (best-effort table name).
  if (Node.isIdentifier(ident)) return text;
  // #397 — `schema.users` namespace-imported reference. The local
  // map only carries identifiers declared in the current source file;
  // for cross-file namespace imports we ask lang-ts to resolve
  // `schema` to its NamespaceImport, then look up `users` in the
  // exporter's declarations. If the binding's initializer is a
  // recognised drizzle-table declaration (pgTable/mysqlTable/sqliteTable),
  // return the string literal name argument.
  if (Node.isPropertyAccessExpression(ident)) {
    const tableName = resolveTableViaNamespaceImport(ident);
    if (tableName) return tableName;
  }
  return null;
}

function resolveTableViaNamespaceImport(propAccess: Node): string | null {
  const decls = resolveNamespaceImportProperty(propAccess);
  for (const decl of decls) {
    if (!Node.isVariableDeclaration(decl)) continue;
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    if (!SCHEMA_DECLARATION_FNS.has(callee.getText())) continue;
    const args = init.getArguments();
    if (args.length === 0) continue;
    const nameArg = args[0];
    if (Node.isStringLiteral(nameArg) || Node.isNoSubstitutionTemplateLiteral(nameArg)) {
      return nameArg.getLiteralValue();
    }
  }
  return null;
}

function handleTableDecl(
  call: CallExpression,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  systemId: string,
  emittedTables: Set<string>,
  emittedColumns: Set<string>,
  tableNameByIdentifier: Map<string, TableInfo>,
): void {
  const args = call.getArguments();
  if (args.length < 2) return;
  const nameArg = args[0];
  let tableName: string | null = null;
  if (Node.isStringLiteral(nameArg) || Node.isNoSubstitutionTemplateLiteral(nameArg)) {
    tableName = nameArg.getLiteralValue();
  }
  if (!tableName) return;

  const tableId = ensureTable(ctx, systemId, tableName, ctx.sourceFile.filePath, emittedTables);

  // Record the binding: `const usersTable = pgTable('users', { ... })`
  // so call-site lookups can map `usersTable` → 'users'.
  const varDecl = call.getFirstAncestor((a) => Node.isVariableDeclaration(a));
  if (varDecl && Node.isVariableDeclaration(varDecl)) {
    tableNameByIdentifier.set(varDecl.getName(), {
      tableName,
      declaredIn: ctx.sourceFile.filePath,
    });
  }

  // Second arg is the shape object.
  const shape = args[1];
  if (!Node.isObjectLiteralExpression(shape)) return;
  for (const prop of shape.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop)) continue;
    const propName = prop.getName();
    const columnId = idFor.databaseColumn({ tableId, name: propName });
    if (emittedColumns.has(columnId)) continue;
    emittedColumns.add(columnId);
    const column: DatabaseColumn = {
      nodeType: 'DatabaseColumn',
      id: columnId,
      tableId,
      name: propName,
      type: null,
      nullable: false,
      isPrimaryKey: false,
      isForeignKey: false,
    };
    ctx.emitNode(column);
    ctx.emitEdge({ edgeType: 'COLUMN_IN', from: columnId, to: tableId });
  }
}

function ensureTable(
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  systemId: string,
  tableName: string,
  declaredIn: string | null,
  emittedTables: Set<string>,
): string {
  const tableId = idFor.databaseTable({ systemId, schema: null, name: tableName });
  if (!emittedTables.has(tableId)) {
    emittedTables.add(tableId);
    const table: DatabaseTable = {
      nodeType: 'DatabaseTable',
      id: tableId,
      systemId,
      name: tableName,
      schema: null,
      kind: 'table',
      declaredIn,
    };
    ctx.emitNode(table);
    ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
  }
  return tableId;
}

function emitInteraction(
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  systemId: string,
  tableId: string | null,
  operation: DatabaseOperation,
  confidence: 'direct' | 'inferred' | 'dynamic',
  node: CallExpression,
): void {
  if (!ctx.enclosingFunction) return;
  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      targetTableId: tableId ?? 'drizzle-raw',
    }),
    callSiteFunctionId: ctx.enclosingFunction.id,
    operation,
    orm: 'drizzle',
    rawQuery: null,
    confidence,
    evidence: buildEvidence(node, ctx.sourceFile.filePath),
  };
  ctx.emitNode(interaction);
  if (tableId) {
    if (operation === 'read') {
      ctx.emitEdge({ edgeType: 'READS', from: interaction.id, to: tableId, columns: null, filters: null });
    } else if (operation === 'write' || operation === 'update' || operation === 'delete') {
      const kind = operation === 'delete' ? 'delete' : operation === 'update' ? 'update' : 'insert';
      ctx.emitEdge({ edgeType: 'WRITES', from: interaction.id, to: tableId, columns: null, kind });
    }
  }
  ctx.emitEdge({
    edgeType: 'PERFORMED_BY',
    from: interaction.id,
    to: ctx.enclosingFunction.id,
    sourceLine: node.getStartLineNumber(),
  });
  void systemId;
}
