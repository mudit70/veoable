import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  idFor,
  type DatabaseInteraction,
  type DatabaseOperation,
  type DatabaseTable,
} from '@adorable/schema';
import type { RustFrameworkVisitor, RustVisitContext } from '@adorable/lang-rust';
import { extractFirstTableOp, type SqlOperation } from './sql-parse.js';

/**
 * sqlx visitor (#439 first slice).
 *
 * Three call shapes:
 *
 *   1. Macro: `sqlx::query!("SQL", ...)`
 *             `sqlx::query_as!(Type, "SQL", ...)`
 *             `sqlx::query_unchecked!("SQL", ...)` (etc.)
 *
 *   2. Function call on the sqlx path:
 *             `sqlx::query("SQL")`
 *             `sqlx::query_as::<_, User>("SQL")`
 *
 *   3. Method call on a connection-like receiver:
 *             `conn.execute("SQL")`
 *             `pool.fetch_one("SQL")`
 *
 * For (1)+(2) the SQL is the first or second string-literal argument
 * (second only for query_as! where the first arg is the type). For
 * (3) the SQL is the first arg; receiver matching is left loose
 * (anything with a string-literal first arg to one of the known
 * verbs) because typed-receiver resolution is out of scope here.
 *
 * Every matched call emits one DatabaseInteraction + a READS or
 * WRITES edge to a synthesized DatabaseTable + a PERFORMED_BY edge
 * back to the enclosing function. Mirrors framework-knex exactly so
 * the existing flow-stitcher + MCP query tools see sqlx-emitted
 * interactions the same way they see knex ones.
 *
 * Detection is conservative:
 *   - SQL must be a string literal (interpreted, raw, or raw#).
 *   - Must contain a recognizable DML verb + table name (see
 *     extractFirstTableOp).
 *   - Receivers for the method-call shape are matched by name
 *     (`conn`, `pool`, `tx`, `db`, etc.) — same gentle filter knex
 *     uses to bound false positives.
 */

const SQLX_FN_NAMES: ReadonlySet<string> = new Set([
  'query',
  'query_as',
  'query_scalar',
  'query_unchecked',
  'query_as_unchecked',
  'query_scalar_unchecked',
]);

/** Method names that take a SQL string as their first arg. */
const METHOD_VERBS: ReadonlySet<string> = new Set([
  'execute',
  'fetch_one',
  'fetch_all',
  'fetch_optional',
  'fetch',
]);

// Receiver-name filter for the method-call shape. `self.` is the only
// modifier we accept (the JS-ism `this.` was an early copy-paste from
// the TS knex plugin; Rust has no `this`).
const RECEIVER_RE = /^(?:self\.)?(conn|pool|tx|trans|transaction|db|database|executor)$/i;

export function createSqlxVisitor(systemId: string): RustFrameworkVisitor {
  const emittedTables = new Set<string>();

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

  const emit = (ctx: RustVisitContext, node: SyntaxNode, sql: string): void => {
    if (!ctx.enclosingFunction) return;
    const parsed = extractFirstTableOp(sql);
    if (!parsed) return;

    const tableId = ensureTable(ctx, parsed.table);
    const operation: DatabaseOperation = toCanonicalOp(parsed.operation);

    const interaction: DatabaseInteraction = {
      nodeType: 'DatabaseInteraction',
      id: idFor.databaseInteraction({
        callSiteFunctionId: ctx.enclosingFunction.id,
        operation,
        targetTableId: tableId,
      }),
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      orm: 'sqlx',
      rawQuery: sql.length <= 500 ? sql : null,
      confidence: 'direct',
      evidence: {
        filePath: ctx.sourceFile.filePath,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        snippet: sql.length <= 500 ? sql : sql.slice(0, 499) + '…',
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
      if (node.type === 'macro_invocation') {
        // sqlx::query! / sqlx::query_as! / ...
        // The macro_invocation's tree-sitter shape:
        //   child[0] = scoped_identifier (macro field) — `sqlx::query`
        //   child[1] = `!`
        //   child[2] = token_tree
        // child[2] is NOT exposed via childForFieldName('token_tree')
        // in our tree-sitter-rust grammar version, so walk children.
        if (!isSqlxMacroPath(node)) return;
        const tokenTree = findChildOfType(node, 'token_tree');
        if (!tokenTree) return;
        // Both query!() and query_as!() put the SQL at the first
        // string-literal slot — the type argument before it in
        // query_as! is an identifier, not a string. So the rule is
        // uniform: first string literal in the token tree wins.
        const sql = firstStringLiteralInTokenTree(tokenTree);
        if (sql) emit(ctx, node, sql);
        return;
      }

      if (node.type !== 'call_expression') return;

      const fn = node.childForFieldName('function');
      if (!fn) return;

      // ── `sqlx::query("SQL")` / `sqlx::query_as::<...>("SQL")` ─
      if (isSqlxFnPath(fn)) {
        const args = node.childForFieldName('arguments');
        if (!args) return;
        const sql = findFirstStringLiteral(args);
        if (sql) emit(ctx, node, sql);
        return;
      }

      // ── `<receiver>.execute("SQL")` / `.fetch_*("SQL")` ──────
      if (fn.type === 'field_expression') {
        const fieldNode = fn.childForFieldName('field');
        if (!fieldNode) return;
        const methodName = fieldNode.text;
        if (!METHOD_VERBS.has(methodName)) return;

        const receiverNode = fn.childForFieldName('value');
        if (!receiverNode) return;
        if (!RECEIVER_RE.test(receiverNode.text)) return;

        const args = node.childForFieldName('arguments');
        if (!args) return;
        const sql = findFirstStringLiteral(args);
        if (sql) emit(ctx, node, sql);
      }
    },
  };
}

function toCanonicalOp(op: SqlOperation): DatabaseOperation {
  switch (op) {
    case 'read': return 'read';
    case 'insert': return 'write';
    case 'update': return 'update';
    case 'delete': return 'delete';
  }
}

/** True for a scoped-identifier `sqlx::<query-ish>`. */
function isSqlxFnPath(fn: SyntaxNode): boolean {
  if (fn.type === 'scoped_identifier') {
    const path = fn.childForFieldName('path');
    const name = fn.childForFieldName('name');
    if (path?.text === 'sqlx' && name?.text && SQLX_FN_NAMES.has(name.text)) return true;
  }
  // `sqlx::query_as::<_, User>` — generic function. Tree-sitter
  // wraps this as `generic_function` containing a `function` child
  // that's the scoped identifier above.
  if (fn.type === 'generic_function') {
    const inner = fn.childForFieldName('function');
    if (inner) return isSqlxFnPath(inner);
  }
  return false;
}

function isSqlxMacroPath(macroInvocation: SyntaxNode): boolean {
  const pathNode = macroInvocation.childForFieldName('macro');
  if (!pathNode) return false;
  if (pathNode.type === 'scoped_identifier') {
    return pathNode.text.startsWith('sqlx::');
  }
  return false;
}

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function firstStringLiteralInTokenTree(tokenTree: SyntaxNode): string | null {
  const walk = (n: SyntaxNode): string | null => {
    if (isStringLiteralType(n.type)) return stripStringQuotes(n.text);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (!c) continue;
      const v = walk(c);
      if (v !== null) return v;
    }
    return null;
  };
  return walk(tokenTree);
}

function findFirstStringLiteral(args: SyntaxNode): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child) continue;
    if (isStringLiteralType(child.type)) {
      return stripStringQuotes(child.text);
    }
  }
  return null;
}

function isStringLiteralType(type: string): boolean {
  return type === 'string_literal' || type === 'interpreted_string_literal' || type === 'raw_string_literal';
}

function stripStringQuotes(text: string): string | null {
  // Mirrors framework-axum's local helper. Promote to a lang-rust
  // export when a third Rust framework needs it (matches the
  // readStringLiteral story PR #438 closed for the TS side).
  if (text.startsWith('r#"') && text.endsWith('"#')) return text.slice(3, -2);
  if (text.startsWith('r"') && text.endsWith('"')) return text.slice(2, -1);
  if (text.startsWith('"') && text.endsWith('"')) {
    // Unescape \" -> " inside an interpreted string literal. Other
    // escapes (\n, \t, etc.) pass through; they don't affect SQL
    // table-name extraction.
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return null;
}
