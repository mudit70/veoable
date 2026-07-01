import { Node, type Project } from 'ts-morph';

/**
 * Cross-file Identifier resolution by **name + kind** as a last-resort
 * fallback when:
 *   - The type checker can't resolve the Identifier (because the import
 *     specifier doesn't physically resolve, e.g. an unannounced
 *     workspace alias whose `paths` weren't synthesized).
 *   - Explicit ImportDeclaration walking returns nothing (target file
 *     not found by `getModuleSpecifierSourceFile()`).
 *
 * This is the heuristic path #195 documents as Layout B: a monorepo
 * without declared workspace metadata where subpackages reference each
 * other by package name. The structural assumption is that an exported
 * name is unique across the project — if `class PostAPIClient` is
 * exported from exactly one file in the loaded Project, that's the
 * intended target.
 *
 * Returns `null` when:
 *   - No matching declaration is found.
 *   - More than one matching declaration is found (ambiguous; refusing
 *     to pick one keeps the fallback safe).
 *
 * Callers SHOULD record a `ConfidenceDecision` when this helper
 * succeeds, since the resolution is structural-name-match rather than
 * type-checker-verified — downstream consumers may want to filter by
 * confidence.
 *
 * @param project ts-morph Project — typically `ctx.project` inside a
 *                framework visitor.
 * @param exportName The Identifier text being looked up.
 * @param predicate Returns true for the kind of declaration we're
 *                  after (e.g. `Node.isClassDeclaration`,
 *                  `Node.isFunctionDeclaration`,
 *                  `(d) => Node.isVariableDeclaration(d) && hasObjectInitializer(d)`).
 *                  The helper itself doesn't know what kind of
 *                  declaration the caller wants, so the predicate is
 *                  required.
 */
export function findUniqueExportedDeclaration(
  project: Project,
  exportName: string,
  predicate: (decl: Node) => boolean,
): Node | null {
  let unique: Node | null = null;
  for (const sourceFile of project.getSourceFiles()) {
    const exported = sourceFile.getExportedDeclarations().get(exportName);
    if (!exported || exported.length === 0) continue;
    for (const decl of exported) {
      if (!predicate(decl)) continue;
      if (unique && unique !== decl) {
        // Ambiguous — two different files export a same-named
        // declaration of the requested kind. Refuse to pick.
        return null;
      }
      unique = decl;
    }
  }
  return unique;
}
