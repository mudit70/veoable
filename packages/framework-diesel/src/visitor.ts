import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseColumn,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import type { RustFrameworkVisitor, RustVisitContext } from '@adorable/lang-rust';
import { parseTableMacro } from './table-macro.js';
import { type DieselImports, isImportedFromDiesel, scanDieselImports } from './imports.js';

/**
 * diesel visitor (#439 second slice).
 *
 * Three extraction surfaces:
 *
 *  1. **Schema declaration** — `diesel::table! { users (id) { ... } }`
 *     macros emit a DatabaseTable plus one DatabaseColumn per declared
 *     column, with TABLE_IN / COLUMN_IN edges and isPrimaryKey set
 *     from the pk tuple.
 *
 *  2. **Write operations** —
 *       diesel::insert_into(<path>)  → write
 *       diesel::update(<path>)       → update
 *       diesel::delete(<path>)       → delete
 *     The first arg is parsed as a scoped expression rooted at
 *     `<table>::table` (or `<table>::table.<chain>`). The Rust-level
 *     table name is the first segment of that path.
 *
 *  3. **Read operations** — method calls whose terminal verb is one
 *     of `load`, `first`, `get_result`, `get_results`, `count`,
 *     `select`, `find` AND whose chain begins at `<table>::table`.
 *
 * One DatabaseInteraction is emitted per matched call site, mirroring
 * the knex / sqlx model. Tables observed via reads/writes but not
 * previously declared via `table!` are still synthesized (some
 * schemas live in a sibling crate we can't see) — they get the bare
 * name but no columns.
 */

const WRITE_FNS = new Map<string, DatabaseOperation>([
  ['insert_into', 'write'],
  ['update', 'update'],
  ['delete', 'delete'],
  // diesel::insert_or_ignore_into is functionally the same as
  // insert_into for our purposes (just a different conflict policy).
  ['insert_or_ignore_into', 'write'],
  ['replace_into', 'write'],
]);

// Only TRUE chain terminals that EXECUTE the query. Continuation
// methods (`find`, `select`, `filter`, `order_by`, `count`, etc.) are
// excluded — including them would double-count every chain because
// the visitor sees both the continuation call and the terminal call
// independently. `count` in particular is deceiving: it returns a
// Count<> builder you then call `.first()` or `.get_result()` on; it
// is NOT itself a terminal. `.execute(...)` is also excluded because
// it appears as the terminal of every write chain too
// (insert/update/delete) and would conflict with their explicit
// write-op detection. Raw-SQL chains via
// `diesel::sql_query("...").execute(...)` aren't detected in this
// slice and become a separate follow-up.
const READ_VERBS = new Set([
  'load',
  'first',
  'get_result',
  'get_results',
]);

export function createDieselVisitor(systemId: string): RustFrameworkVisitor {
  const emittedTables = new Set<string>();
  // Per-file index of `use diesel::*` imports, populated lazily on
  // the first node we see from each file. The lang-rust traversal
  // doesn't dispatch the source_file root to visitors, so we build
  // this on demand the way framework-axum's fileImportsAxum does.
  const importsByFile = new Map<string, DieselImports>();
  const getImports = (ctx: RustVisitContext, node: SyntaxNode): DieselImports => {
    const key = ctx.sourceFile.filePath;
    let imp = importsByFile.get(key);
    if (!imp) {
      imp = scanDieselImports(node.tree.rootNode);
      importsByFile.set(key, imp);
    }
    return imp;
  };

  const ensureTable = (ctx: RustVisitContext, name: string): string => {
    const tableId = idFor.databaseTable({ systemId, schema: null, name });
    if (!emittedTables.has(tableId)) {
      emittedTables.add(tableId);
      const table: DatabaseTable = {
        nodeType: 'DatabaseTable',
        id: tableId,
        systemId,
        name,
        schema: null,
        kind: 'table',
        declaredIn: null,
      };
      ctx.emitNode(table);
      ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
    }
    return tableId;
  };

  const emitInteraction = (
    ctx: RustVisitContext,
    node: SyntaxNode,
    tableName: string,
    operation: DatabaseOperation,
  ): void => {
    if (!ctx.enclosingFunction) return;
    const tableId = ensureTable(ctx, tableName);

    const interaction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        targetTableId: tableId,
      }),
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      orm: 'diesel',
      rawQuery: null,
      confidence: 'direct',
      evidence: {
        filePath: ctx.sourceFile.filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        snippet: node.text.length <= 500 ? node.text : node.text.slice(0, 499) + '…',
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
  };

  return {
    language: 'rust',
    onNode(ctx, node) {
      // ── 1. `diesel::table! { ... }` declaration ──────────────
      if (node.type === 'macro_invocation' && isDieselTableMacroPath(node, () => getImports(ctx, node))) {
        const tokenTree = findChildOfType(node, 'token_tree');
        if (!tokenTree) return;
        const parsed = parseTableMacro(tokenTree.text);
        if (!parsed) return;

        const tableId = idFor.databaseTable({
          systemId,
          schema: null,
          name: parsed.name,
        });
        // Always emit (even if a prior read/write pre-emitted a bare
        // copy) — the declaration carries more information than the
        // synthesized version. Dedup is by id, so the second emit
        // updates the canonical-store copy with our column-bearing
        // version.
        if (!emittedTables.has(tableId)) {
          emittedTables.add(tableId);
          const table: DatabaseTable = {
            nodeType: 'DatabaseTable',
            id: tableId,
            systemId,
            name: parsed.name,
            schema: null,
            kind: 'table',
            declaredIn: ctx.sourceFile.id,
          };
          ctx.emitNode(table);
          ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
        }

        for (const col of parsed.columns) {
          const columnId = idFor.databaseColumn({ tableId, name: col.name });
          const column: DatabaseColumn = {
            nodeType: 'DatabaseColumn',
            id: columnId,
            tableId,
            name: col.name,
            type: col.sqlType,
            nullable: col.sqlType ? col.sqlType.startsWith('Nullable<') : null,
            isPrimaryKey: col.isPrimaryKey,
            isForeignKey: false, // joinable! macros are a follow-up.
          };
          ctx.emitNode(column);
          ctx.emitEdge({ edgeType: 'COLUMN_IN', from: columnId, to: tableId });
        }
        return;
      }

      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (!fn) return;

      // ── 2. Write op: `diesel::insert_into(<path>)` etc. ──────
      const writeOp = matchDieselWriteFn(fn, () => getImports(ctx, node));
      if (writeOp !== null) {
        const args = node.childForFieldName('arguments');
        if (!args) return;
        const tableName = readTableNameFromArgs(args);
        if (tableName) emitInteraction(ctx, node, tableName, writeOp);
        return;
      }

      // ── 3. Read op: terminal verb on a `<table>::table` chain ─
      if (fn.type === 'field_expression') {
        const fieldNode = fn.childForFieldName('field');
        if (!fieldNode) return;
        const methodName = fieldNode.text;
        if (!READ_VERBS.has(methodName)) return;

        const receiverNode = fn.childForFieldName('value');
        if (!receiverNode) return;
        const tableName = findRootTableInChain(receiverNode);
        if (tableName) emitInteraction(ctx, node, tableName, 'read');
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tree-sitter shape helpers
// ─────────────────────────────────────────────────────────────────────

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function isDieselTableMacroPath(
  macroInvocation: SyntaxNode,
  getImp: () => DieselImports,
): boolean {
  const macroNode = macroInvocation.childForFieldName('macro');
  if (!macroNode) return false;
  // Fully scoped — `diesel::table!`.
  if (macroNode.type === 'scoped_identifier' && macroNode.text === 'diesel::table') {
    return true;
  }
  // Bare `table!{...}` after a `use diesel::table;` or
  // `use diesel::prelude::*;` import. The import gate keeps an
  // unrelated `table!` macro in a non-diesel file from registering.
  if (macroNode.type === 'identifier' && macroNode.text === 'table') {
    return isImportedFromDiesel(getImp(), 'table');
  }
  return false;
}

function matchDieselWriteFn(
  fn: SyntaxNode,
  getImp: () => DieselImports,
): DatabaseOperation | null {
  // Scoped — `diesel::insert_into(...)`.
  if (fn.type === 'scoped_identifier') {
    const path = fn.childForFieldName('path');
    const name = fn.childForFieldName('name');
    if (path?.text === 'diesel' && name?.text) {
      return WRITE_FNS.get(name.text) ?? null;
    }
  }
  // Bare — `insert_into(<path>)`, `update(<path>)`, `delete(<path>)`
  // when the symbol is imported from diesel in this file. Without
  // the import gate every `delete(x)` in non-diesel code would
  // false-positive (Vec::delete style methods, custom delete
  // free-functions, etc.).
  if (fn.type === 'identifier') {
    // `Map.get` returns `T | undefined` — `null` is unreachable.
    const op = WRITE_FNS.get(fn.text);
    if (op !== undefined && isImportedFromDiesel(getImp(), fn.text)) {
      return op;
    }
  }
  return null;
}

/**
 * Read the first argument of a `diesel::insert_into(<expr>)` call
 * (etc.) and return the Rust-level table name from a `<name>::table`
 * scoped identifier. Returns null when the arg isn't a recognizable
 * table-path expression — at which point the call goes unrecorded.
 *
 *   insert_into(users::table)               → "users"
 *   update(users::table.find(1))            → "users"
 *   delete(users::table.filter(x.eq(y)))    → "users"
 *
 * Conservative: callers that build the table reference dynamically
 * (e.g. `let t = users::table; insert_into(t)`) require const
 * propagation we don't yet do here.
 */
function readTableNameFromArgs(args: SyntaxNode): string | null {
  // Skip the outer `(` / `)` and any inline comments; find the first
  // named child that's a real expression.
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child || !child.isNamed) continue;
    if (child.type === 'line_comment' || child.type === 'block_comment') continue;
    return findRootTableInChain(child);
  }
  return null;
}

/**
 * Walk down a method-chain receiver looking for the root
 * `<table>::table` reference. The chain shapes we accept:
 *
 *   users::table
 *   users::table.find(1)
 *   users::table.filter(x).order_by(y)
 *   schema::users::table.filter(...)  →  "users" (we strip schema)
 */
function findRootTableInChain(node: SyntaxNode): string | null {
  // Walk the leftmost child of every field_expression / call_expression
  // until we find a scoped_identifier ending in `::table`.
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === 'scoped_identifier' && current.text.endsWith('::table')) {
      const path = current.childForFieldName('path');
      if (!path) return null;
      // path text is the segment(s) before `::table`. Strip any
      // schema-style prefix: `app::schema::users` → `users`.
      const segs = path.text.split('::');
      const tableName = segs[segs.length - 1];
      return tableName || null;
    }
    if (current.type === 'field_expression') {
      current = current.childForFieldName('value');
      continue;
    }
    if (current.type === 'call_expression') {
      current = current.childForFieldName('function');
      continue;
    }
    if (current.type === 'generic_function') {
      current = current.childForFieldName('function');
      continue;
    }
    return null;
  }
  return null;
}
