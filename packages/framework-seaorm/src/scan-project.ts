import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Project-wide pre-scan for SeaORM entity → table-name mappings.
 *
 * Runs once per analysis run from `SeaormPlugin.onProjectLoaded`. We
 * cannot rely on the per-file scan alone because real SeaORM
 * codebases place entity declarations in `src/entities/*.rs` and the
 * `User::find()` call sites in `src/handlers/*.rs` — different files.
 *
 * Two passes over the Rust files:
 *
 * Pass A — find every `#[sea_orm(table_name = "X")]` attribute and
 *          track the module path it sits in. Output keyed by the
 *          struct identifier that immediately follows the attribute
 *          AND by the enclosing-module's name (for the common
 *          `mod user { struct Entity; }` layout). Also keyed under
 *          the LAST segment of the file's path (e.g. `user.rs` →
 *          `user`).
 *
 * Pass B — find `pub use <path>::Entity as <Alias>;` statements and
 *          chain the alias through to the table_name. So
 *          `pub use entity::user::Entity as User;` records
 *          `'User' → 'users'`.
 *
 * Text-based parsing on file contents. Tree-sitter would be more
 * correct but each plugin instance would need its own parser, which
 * the CLAUDE.md invariant forbids. The regex is conservative enough
 * to avoid false positives in practice — real-world SeaORM code
 * follows the generated layout closely.
 */
export function scanProjectForTableNames(rootDir: string, relFiles: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  // (alias-name → struct-name) from `pub use ... as X` lines
  const aliases = new Map<string, string>();
  // (struct-name → table_name)
  const byStruct = new Map<string, string>();
  // (last segment of file path → table_name) — fallback key for the
  // common `mod foo` layout. e.g. `src/entities/user.rs` → `user`.
  const byModuleStem = new Map<string, string>();

  const attrRe = /#\[\s*sea_orm\s*\(\s*table_name\s*=\s*"([^"]+)"\s*\)\s*\]/g;
  const aliasRe = /pub\s+use\s+[\w:]+::(\w+)\s+as\s+(\w+)\s*;/g;

  for (const rel of relFiles) {
    if (!rel.endsWith('.rs')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(rootDir, rel), 'utf-8');
    } catch {
      continue;
    }

    const stem = path.basename(rel, '.rs');

    // Pass A
    attrRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(text)) !== null) {
      const tableName = m[1];
      // Find the next `struct <Name>` after this attribute.
      const after = text.slice(m.index);
      const sm = /struct\s+(\w+)/.exec(after);
      if (sm) byStruct.set(sm[1], tableName);
      byModuleStem.set(stem, tableName);
      out.set('Entity', tableName);  // global last-wins fallback
    }

    // Pass B (`pub use ... as Alias`)
    aliasRe.lastIndex = 0;
    while ((m = aliasRe.exec(text)) !== null) {
      const innerStruct = m[1];
      const alias = m[2];
      aliases.set(alias, innerStruct);
    }
  }

  // Resolve `alias → struct → table_name`. If the inner struct is
  // `Entity` (the common case), try the module-stem map too.
  for (const [alias, struct] of aliases) {
    const t = byStruct.get(struct);
    if (t) {
      out.set(alias, t);
      continue;
    }
    // `pub use entity::user::Entity as User;` — struct = `Entity`,
    // alias = `User`. Look at every byModuleStem entry; if there's a
    // single match for `user` (the alias lowercased), use it.
    // Simple heuristic: alias snake_case must match a module-stem.
    const stem = toSnakeCase(alias);
    const t2 = byModuleStem.get(stem);
    if (t2) out.set(alias, t2);
  }

  // Direct byStruct entries are useful too.
  for (const [struct, t] of byStruct) {
    if (!out.has(struct)) out.set(struct, t);
  }

  return out;
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
