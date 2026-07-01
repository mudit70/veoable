import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;

/**
 * Per-file index of names imported FROM a given crate. Framework
 * plugins use this to decide whether a bare-form call (e.g.
 * `insert_into(users::table)` after `use diesel::insert_into;`) or
 * a bare attribute (e.g. `#[async_trait]` after
 * `use tonic::async_trait;`) should be treated as a crate-X call
 * site or ignored as a same-named local symbol.
 *
 *   use diesel::insert_into;            → names = {'insert_into'}
 *   use diesel::{insert_into, update};  → names = {'insert_into', 'update'}
 *   use diesel::*;                      → hasGlob = true
 *   use diesel::prelude::*;             → hasGlob = true
 *
 * Deferred (each tracked separately):
 *   - `use diesel::insert_into as ins;` — aliased imports.
 *   - `use diesel as d;` — root crate alias.
 *   - Nested `use diesel::{foo, bar::Baz};` — only flat lists today.
 *   - `use diesel::prelude::SomeTrait;` — names under an intermediate
 *     module segment. Our regex requires the imported name directly
 *     under `<crate>::`, so these are silently dropped (no false
 *     positive, no false negative — these aren't write-op call sites).
 */
export interface CrateImports {
  /** Names imported by-name from `<crate>::...`. */
  names: ReadonlySet<string>;
  /** True if `<crate>::*;` or `<crate>::prelude::*;` is in scope. */
  hasGlob: boolean;
}

/**
 * Scan top-level `use_declaration` nodes for imports from the named
 * crate. Returns `{ names: empty, hasGlob: false }` for files with no
 * such imports — bare-form detection in framework plugins then declines.
 *
 * Text-based parsing on the use_declaration's full text, NOT
 * walking tree-sitter's nested shapes (scoped_use_list,
 * use_as_clause, use_wildcard, ...). Those vary slightly between
 * grammar versions and the regex shape is small enough to handle the
 * cases we care about. Aliased and root-alias forms are intentionally
 * dropped via the substring guard (`includes(' as ')`).
 *
 * The crate name is escaped before going into a regex so callers can
 * safely pass arbitrary identifiers (`framework-mcp-server-rust` may
 * someday want a hyphenated crate name; today only simple identifiers
 * are real but we don't want a footgun).
 */
export function scanCrateImports(rootNode: SyntaxNode, crateName: string): CrateImports {
  const names = new Set<string>();
  let hasGlob = false;

  const c = escapeRegex(crateName);
  const globRe = new RegExp(`\\buse\\s+${c}\\s*::\\s*(?:prelude\\s*::\\s*)?\\*\\s*;`);
  const groupRe = new RegExp(`\\buse\\s+${c}\\s*::\\s*\\{([^}]+)\\}\\s*;`);
  const singleRe = new RegExp(`\\buse\\s+${c}\\s*::\\s*([a-zA-Z_]\\w*)\\s*;`);

  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (!child || child.type !== 'use_declaration') continue;
    const text = child.text;
    if (!text.includes(crateName)) continue;

    if (globRe.test(text)) {
      hasGlob = true;
      continue;
    }

    const groupMatch = text.match(groupRe);
    if (groupMatch) {
      for (const part of groupMatch[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (trimmed.includes(' as ')) continue;
        if (/^[a-zA-Z_]\w*$/.test(trimmed)) names.add(trimmed);
      }
      continue;
    }

    const singleMatch = text.match(singleRe);
    if (singleMatch) {
      names.add(singleMatch[1]);
    }
  }

  return { names, hasGlob };
}

/** True iff `name` is in scope as a crate-origin identifier in `imp`. */
export function isImportedFromCrate(imp: CrateImports, name: string): boolean {
  return imp.hasGlob || imp.names.has(name);
}

/**
 * Cheap "does this file mention `<crate>` at all?" check for plugins
 * that only need the boolean signal (framework-axum's
 * `fileImportsAxum` use case). Avoids the full scan when the file
 * doesn't reference the crate's name anywhere.
 */
export function hasCrateImport(rootNode: SyntaxNode, crateName: string): boolean {
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (!child || child.type !== 'use_declaration') continue;
    if (child.text.includes(crateName)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
