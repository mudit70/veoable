/**
 * Lightweight SQL → (table, operation) extractor for the first slice
 * of #439. Recognizes the four DML verbs:
 *
 *   SELECT ... FROM <table>            → read
 *   INSERT INTO <table>                → insert
 *   UPDATE <table>                     → update
 *   DELETE FROM <table>                → delete
 *
 * The first matched table+verb in the string is returned. SQL with
 * leading whitespace, comments, or schema-qualified table names
 * (`public.users`, `app.users`) are tolerated; the helper strips the
 * schema prefix because our DatabaseTable id is unschemed in the
 * sqlx (no-schema-declaration) world. Strings without one of these
 * verbs return null — sqlx callers commonly use DDL like CREATE
 * TABLE / ALTER, which we ignore in this slice.
 *
 * Conservative on purpose: multi-table joins, CTE-only queries, and
 * subqueries return the FIRST table seen, not every touched table.
 * That matches knex's "one DatabaseInteraction per call site" model
 * and keeps the first slice scoped.
 *
 * This is NOT a real SQL parser. It does not validate syntax. If
 * sqlx ever lets through an invalid query, neither do we.
 */

export type SqlOperation = 'read' | 'insert' | 'update' | 'delete';

export interface SqlTableOp {
  table: string;
  operation: SqlOperation;
}

// Order matters here. We want write operations to take precedence over
// SELECT because:
//   1. Outer INSERT/UPDATE/DELETE may contain a SELECT subquery
//      (e.g. `INSERT INTO logs SELECT * FROM events`) and the load-
//      bearing effect is the write.
//   2. The DML keywords are more discriminating than SELECT, so we
//      avoid the rare false positive where SELECT matches first only
//      because INSERT/UPDATE/DELETE appears inside a string literal.
//      (We don't tokenize SQL strings — see stripComments — so this
//      regex-level ordering is the only line of defense.)
const PATTERNS: ReadonlyArray<{ re: RegExp; operation: SqlOperation }> = [
  { re: /\binsert\s+into\s+([a-zA-Z_][\w.]*)/i, operation: 'insert' },
  { re: /\bupdate\s+([a-zA-Z_][\w.]*)\s+set\b/i, operation: 'update' },
  { re: /\bdelete\s+from\s+([a-zA-Z_][\w.]*)/i, operation: 'delete' },
  // SELECT ... FROM <table> — `[\s\S]*?` is non-greedy and crosses
  // newlines because sqlx macros frequently have multi-line SQL.
  { re: /\bselect\b[\s\S]*?\bfrom\s+([a-zA-Z_][\w.]*)/i, operation: 'read' },
];

/**
 * Strip block + line comments and normalize whitespace before
 * matching. SQL comments often hide the table-name match
 * (e.g. `-- DELETE FROM users` accidentally tripping the delete
 * regex). We keep this pass cheap; the helper isn't on a hot path.
 *
 * This is regex-based, not a real SQL tokenizer — `--` or `/*`
 * inside a string literal would also get stripped. In practice this
 * only matters if a string literal happens to contain a SQL keyword
 * that would change the table match downstream, which is rare. The
 * PATTERNS ordering above also limits the blast radius.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* block */
    .replace(/--[^\n]*/g, ' ');         // -- line
}

/**
 * Strip a leading schema prefix (`public.users` → `users`). Multiple
 * dots beyond `schema.table` (e.g. `db.schema.table`) keep the last
 * segment.
 */
function stripSchema(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

export function extractFirstTableOp(sql: string): SqlTableOp | null {
  const cleaned = stripComments(sql);
  for (const { re, operation } of PATTERNS) {
    const m = cleaned.match(re);
    if (m && m[1]) {
      return { table: stripSchema(m[1]), operation };
    }
  }
  return null;
}
