/**
 * Parse the inside of a `diesel::table! { ... }` macro body into a
 * structured TableDecl. Tree-sitter doesn't parse the macro body for
 * us — it ships as a raw token_tree string — so we run a small
 * regex-based parser tuned for the diesel-defined grammar.
 *
 * The full diesel grammar supports:
 *   - Optional `use ...;` lines before the table block (imports of
 *     SQL types).
 *   - Optional `#[sql_name = "..."]` attribute renaming the SQL table.
 *   - A required `<name> (<pk_cols>) { ... }` block.
 *   - Each column row: `<column_name> -> <SqlType>,`
 *
 * For the first slice we extract:
 *   - the Rust-level table name (`users` in `users (id) { ... }`)
 *   - the column names + SQL types
 *   - which columns are primary keys (from the `(id)` tuple)
 *
 * Deferred:
 *   - `#[sql_name = ...]` rename (we use the Rust name).
 *   - Nullable detection (diesel encodes nullable as `Nullable<T>`
 *     wrapper — easy follow-up).
 *   - Foreign-key extraction from `joinable!` macros (separate file).
 */

export interface ParsedColumn {
  name: string;
  sqlType: string | null;
  isPrimaryKey: boolean;
}

export interface ParsedTable {
  /** Rust-level table name (the identifier before the `(pk)` tuple). */
  name: string;
  /** Column declarations in source order. */
  columns: ParsedColumn[];
}

/**
 * Parse the body string of a `diesel::table!` macro invocation. Body
 * INCLUDES the outer `{ ... }` braces (caller passes the token_tree's
 * raw text).
 *
 * Returns null when the body doesn't look like a `table!` declaration
 * — e.g. a different macro that happened to be matched, an empty
 * token tree, or a malformed declaration we can't safely parse.
 */
export function parseTableMacro(body: string): ParsedTable | null {
  // Strip leading/trailing braces if present (the caller may pass the
  // token_tree text which is `{ ... }`).
  let inner = body.trim();
  if (inner.startsWith('{') && inner.endsWith('}')) {
    inner = inner.slice(1, -1);
  } else if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1);
  }

  // Drop `use ...;` lines and `#[...]` attributes — they don't carry
  // the schema info we care about for this slice.
  inner = inner
    .replace(/use\s+[^;]+;/g, '')
    .replace(/#\[[^\]]*\]/g, '');

  // Match the table-decl header:
  //   <table_name> (<pk_cols>) { <columns> }
  // <pk_cols> is one or more comma-separated identifiers — diesel
  // permits compound primary keys.
  const m = inner.match(
    /([a-zA-Z_]\w*)\s*\(\s*([^)]+?)\s*\)\s*\{([\s\S]*)\}/,
  );
  if (!m) return null;

  const tableName = m[1];
  const pkCols = new Set(
    m[2].split(',').map((s) => s.trim()).filter(Boolean),
  );
  const columnBlock = m[3];

  // Each column row: `<name> -> <SqlType>,`
  // Multi-segment types (`Nullable<Text>`, `Array<Integer>`,
  // `Geography<Point, 4326>`) are captured wholesale, with the type
  // spanning across commas that live INSIDE `<...>` generics. The
  // type may also span newlines for verbose Postgres types. A simple
  // regex can't express "comma at bracket-depth zero" — we split the
  // column block manually with a small bracket-aware scanner.
  const columns: ParsedColumn[] = [];
  for (const segment of splitAtTopLevelCommas(columnBlock)) {
    const m = segment.match(/^\s*([a-zA-Z_]\w*)\s*->\s*([\s\S]+?)\s*$/);
    if (!m) continue;
    const name = m[1];
    const sqlType = m[2].replace(/\s+/g, ' ').trim();
    columns.push({
      name,
      sqlType: sqlType || null,
      isPrimaryKey: pkCols.has(name),
    });
  }

  if (columns.length === 0) return null;
  return { name: tableName, columns };
}

/**
 * Split a column-block string at commas that live at bracket depth
 * zero (i.e., NOT inside `<...>` generic-type parameters). Returns
 * the segments with leading/trailing whitespace preserved — the
 * caller's regex tolerates that.
 */
function splitAtTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') depth++;
    else if (c === '>' && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  // Tail segment (the last column may have no trailing comma).
  const tail = s.slice(start);
  if (tail.trim().length > 0) out.push(tail);
  return out;
}
