import { Node, type Identifier } from 'ts-morph';

/**
 * Cross-file Identifier resolution helpers (#200).
 *
 * Two complementary strategies share a goal: take an Identifier and
 * return the declaration it points at, even when the declaration
 * lives in another file or behind an aliased import.
 *
 *   1. **Type-checker-first** (`resolveIdentifierTypeToDeclaration`).
 *      The TS type checker has already reconciled path-mapped imports
 *      and aliased re-exports by the time we call it; asking for
 *      `getType().getSymbol().getDeclarations()` skips the syntactic
 *      walk entirely and works through workspace aliases as soon as
 *      the orchestrator registers their `compilerOptions.paths`
 *      (#195). This is the proven approach already used by the fetch
 *      wrapper-resolver.
 *
 *   2. **Syntactic import walk** (`resolveImportedDeclarations`).
 *      Boilerplate for `walk-up-to-ImportDeclaration ->
 *      getModuleSpecifierSourceFile() -> getExportedDeclarations()`.
 *      Used as a fallback when the type checker can't help (e.g., the
 *      ts-morph Project hasn't been told about a workspace alias and
 *      the import specifier is a relative path).
 *
 * Callers typically try (1) first and fall back to (2). When both
 * fail, callers SHOULD record a `ConfidenceDecision` so coverage
 * gaps surface in observability rather than silently dropping
 * cross-file bindings.
 */

/**
 * Resolve an Identifier to its target declaration via the TS type
 * checker. Returns the first declaration matching `predicate`, or
 * null if the type has no symbol or no matching declaration.
 *
 * Why type-checker-first rather than `Identifier.getSymbol()` walks?
 * `getSymbol()` returns the import-side symbol when called on an
 * imported identifier — the caller still has to chase the import
 * specifier to the target file. `getType().getSymbol()` returns the
 * already-reconciled symbol on the target declaration directly. It
 * also threads through path-mapped imports, namespace re-exports,
 * and `export * from` chains without manual walking.
 *
 * The predicate is required because callers know what kind of
 * declaration they want (ClassDeclaration, FunctionDeclaration,
 * VariableDeclaration with an ObjectLiteral initializer, etc.).
 *
 * @param ident      The Identifier to resolve.
 * @param predicate  Returns true for the kind of declaration the
 *                   caller wants; the helper iterates declarations
 *                   in order and returns the first match.
 */
export function resolveIdentifierTypeToDeclaration(
  ident: Identifier,
  predicate: (decl: Node) => boolean,
): Node | null {
  // Strategy 1: walk the identifier's symbol, following alias chains
  // (renamed imports, `export { x } from './a'`, etc.). This catches
  // most cross-file cases without invoking the full type checker.
  try {
    const sym = ident.getSymbol();
    if (sym) {
      const aliased = (() => {
        try { return sym.getAliasedSymbol(); } catch { return undefined; }
      })();
      const target = aliased ?? sym;
      for (const d of target.getDeclarations()) {
        if (predicate(d)) return d;
      }
    }
  } catch {
    // fall through
  }

  // Strategy 2: ask the type checker for the resolved type's symbol.
  // Catches cases where the syntactic walk above couldn't follow a
  // re-export chain or path-mapped import (the type checker has
  // already reconciled them).
  try {
    const type = ident.getType();
    const tsym = type.getSymbol() ?? type.getAliasSymbol();
    if (tsym) {
      for (const d of tsym.getDeclarations()) {
        if (predicate(d)) return d;
      }
    }
  } catch {
    // fall through
  }

  return null;
}

/**
 * Walk from an import-side declaration node (ImportSpecifier,
 * ImportClause, NamespaceImport) up to its enclosing
 * ImportDeclaration, follow `getModuleSpecifierSourceFile()` to the
 * target file, and return the declarations exported under
 * `exportName`.
 *
 * Returns an empty array on:
 *   - non-import-side input,
 *   - missing import declaration,
 *   - import target not resolved (e.g., a workspace alias whose
 *     `paths` weren't registered),
 *   - the target file does not export `exportName`.
 *
 * @param importSideDecl  An ImportSpecifier / ImportClause /
 *                        NamespaceImport node, typically from
 *                        `Identifier.getSymbol().getDeclarations()`.
 * @param exportName      The exported binding name to look up in the
 *                        target file. For renamed imports, this is
 *                        the *exported* name (not the local rename).
 */
export function resolveImportedDeclarations(
  importSideDecl: Node,
  exportName: string,
): Node[] {
  let current: Node | undefined = importSideDecl;
  while (current && !Node.isImportDeclaration(current)) {
    current = current.getParent();
  }
  if (!current || !Node.isImportDeclaration(current)) return [];

  let target;
  try {
    target = current.getModuleSpecifierSourceFile();
  } catch {
    return [];
  }
  if (!target) return [];

  const map = target.getExportedDeclarations();
  return map.get(exportName) ?? [];
}

/**
 * Resolve a `<namespace>.<propertyName>` access expression to the
 * exported declarations of `propertyName` in the file `<namespace>`
 * is imported from. Used by framework plugins that consume
 * cross-file namespace imports — e.g., framework-drizzle's
 * `tx.insert(schema.users)` shape where `schema` is
 * `import * as schema from './schema'` (#397).
 *
 * Returns `[]` when:
 *   - The receiver isn't an Identifier or doesn't resolve to a
 *     NamespaceImport (e.g., `obj.field` on a plain object).
 *   - The import target file isn't resolvable (unregistered alias).
 *   - The property name isn't an export of the target file.
 *
 * @param propAccess A `PropertyAccessExpression` of the form
 *                   `<namespaceIdent>.<propName>`.
 */
export function resolveNamespaceImportProperty(propAccess: Node): Node[] {
  if (!Node.isPropertyAccessExpression(propAccess)) return [];
  const receiver = propAccess.getExpression();
  if (!Node.isIdentifier(receiver)) return [];
  const propName = propAccess.getNameNode().getText();
  const sym = receiver.getSymbol();
  if (!sym) return [];
  for (const decl of sym.getDeclarations()) {
    // Direct namespace import: `import * as schema from './schema'`.
    if (Node.isNamespaceImport(decl)) {
      return resolveImportedDeclarations(decl, propName);
    }
    // Re-exported namespace: `import { schema } from './db'` where
    // db.ts itself does `import * as schema from './schema'; export
    // { schema }`. Follow the named import to db.ts's `schema`
    // export — ts-morph's getExportedDeclarations for that re-export
    // returns the underlying SourceFile (the namespace's module),
    // not a NamespaceImport node. Look up propName in that source
    // file's exported declarations.
    if (Node.isImportSpecifier(decl) || Node.isImportClause(decl)) {
      const exportName = Node.isImportSpecifier(decl)
        ? decl.getName()
        : 'default';
      const reExports = resolveImportedDeclarations(decl, exportName);
      for (const re of reExports) {
        if (Node.isSourceFile(re)) {
          return re.getExportedDeclarations().get(propName) ?? [];
        }
        if (Node.isNamespaceImport(re)) {
          // Defensive: ts-morph could in theory surface the
          // NamespaceImport itself for some shapes; handle it the
          // same way as the direct case.
          return resolveImportedDeclarations(re, propName);
        }
      }
    }
  }
  return [];
}
