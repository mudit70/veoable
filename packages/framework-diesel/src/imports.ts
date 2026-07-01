import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import {
  scanCrateImports,
  isImportedFromCrate,
  type CrateImports,
} from '@adorable/lang-rust';

/**
 * #442 — file-local `use diesel::*` import index, now a thin wrapper
 * around lang-rust's generic `scanCrateImports`. Extracted as part of
 * #444 once framework-axum, framework-diesel, and framework-tonic all
 * needed the same pattern.
 */
export type DieselImports = CrateImports;

/** Scan top-level `use_declaration` nodes for diesel imports. */
export function scanDieselImports(rootNode: SyntaxNode): DieselImports {
  return scanCrateImports(rootNode, 'diesel');
}

/** True iff `name` is in scope as a diesel-origin identifier in `imp`. */
export function isImportedFromDiesel(imp: DieselImports, name: string): boolean {
  return isImportedFromCrate(imp, name);
}
