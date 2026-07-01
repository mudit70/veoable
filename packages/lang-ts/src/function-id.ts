import * as path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { idFor } from '@adorable/schema';
import type { TsProjectInternal } from './project-handle.js';

/**
 * Identification of function-shaped declarations and the canonical
 * `FunctionDefinition` ids that back them.
 *
 * Both the structural walker (`extract-source-file.ts`) and the call
 * resolver (`extract-calls.ts`) need to map a ts-morph declaration to
 * the same `FunctionDefinition` id. Putting that mapping in one place
 * keeps them in sync — if the structural walker changes how it names a
 * method, the call resolver picks up the same name automatically.
 */

/**
 * The set of ts-morph node kinds the structural walker treats as
 * `FunctionDefinition` shapes. Used by the call resolver to decide
 * whether a callee declaration corresponds to a node we will have
 * emitted.
 */
export function isFunctionShape(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  );
}

/**
 * Compute the human-readable `name` field of the `FunctionDefinition`
 * for a given declaration. Mirrors the structural walker exactly:
 *
 *   - function declaration       → its declared name (or `<anonymous>`)
 *   - class method               → `<ClassName>.<methodName>`
 *   - class getter / setter      → `<ClassName>.get <name>` / `set <name>`
 *   - class constructor          → `<ClassName>.constructor`
 *   - arrow / fn-expr bound to a `const`/`let`/`var` → variable name
 *   - anonymous arrow / fn-expr  → `null` (not a `FunctionDefinition`)
 */
export function functionDefinitionName(node: Node): string | null {
  if (Node.isFunctionDeclaration(node)) {
    return node.getName() ?? '<anonymous>';
  }
  if (Node.isMethodDeclaration(node)) {
    const cls = enclosingClass(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    return `${cn}.${node.getName()}`;
  }
  if (Node.isGetAccessorDeclaration(node)) {
    const cls = enclosingClass(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    return `${cn}.get ${node.getName()}`;
  }
  if (Node.isSetAccessorDeclaration(node)) {
    const cls = enclosingClass(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    return `${cn}.set ${node.getName()}`;
  }
  if (Node.isConstructorDeclaration(node)) {
    const cls = enclosingClass(node);
    const cn = cls ? classNameOf(cls) : '<anonymous-class>';
    return `${cn}.constructor`;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    // Variable-bound: `const fn = () => {}`
    const variable = node.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (variable) return variable.getName();

    // Object literal property: `const api = { getUsers: () => {} }`
    // Name must match the structural extractor's inferCallbackName.
    const propAssignment = node.getParentIfKind(SyntaxKind.PropertyAssignment);
    if (propAssignment) {
      const propName = propAssignment.getNameNode();
      if (Node.isIdentifier(propName)) {
        const objLiteral = propAssignment.getParent();
        if (objLiteral && Node.isObjectLiteralExpression(objLiteral)) {
          const varDecl = objLiteral.getParentIfKind(SyntaxKind.VariableDeclaration);
          if (varDecl) {
            return `${varDecl.getName()}.${propName.getText()}`;
          }
        }
        return propName.getText();
      }
    }

    return null;
  }
  return null;
}

/**
 * Compute the canonical `FunctionDefinition` id for a function-shaped
 * declaration, regardless of which file it lives in. Returns `null`
 * when the declaration isn't a recognized function shape, isn't named
 * (anonymous expression), or lives outside the project root (external
 * module).
 */
/**
 * Compute the canonical FunctionDefinition.id for a declaration.
 * Accepts the minimal shape `{rootDir, repository}` so framework
 * visitors can call this from `TsVisitContext` without exposing the
 * full `TsProjectInternal` handle (#263 — replaces the duplicated
 * resolvers in framework-state-mgmt and framework-react-native).
 */
export function functionDefinitionIdFor(
  internal: Pick<TsProjectInternal, 'rootDir' | 'repository'>,
  declaration: Node
): string | null {
  // #263 — accept a VariableDeclaration whose initializer is a
  // function-shape, by descending to the initializer. The type checker
  // commonly points an imported `const handler = () => {}` reference
  // at the VariableDeclaration itself, not at the arrow inside.
  let resolved: Node = declaration;
  if (Node.isVariableDeclaration(declaration)) {
    const init = declaration.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      resolved = init;
    }
  }
  if (!isFunctionShape(resolved)) return null;
  const name = functionDefinitionName(resolved);
  if (name === null) return null;

  const declSourceFile = resolved.getSourceFile();
  const declAbsolutePath = declSourceFile.getFilePath();
  const declRoot = path.resolve(internal.rootDir);

  // Reject anything outside the project root — we cannot identify
  // external module declarations as `FunctionDefinition`s because we
  // never emitted them.
  if (!declAbsolutePath.startsWith(declRoot + path.sep) && declAbsolutePath !== declRoot) {
    return null;
  }

  const filePath = declAbsolutePath.slice(declRoot.length + 1).split(path.sep).join('/');
  const sourceFileId = idFor.sourceFile({
    repository: internal.repository,
    filePath,
  });
  // Use `resolved`'s line so VariableDeclaration→arrow descent picks
  // the initializer's start line (matches what the structural extractor
  // emits for variable-bound arrows: see extract-source-file.ts:285
  // which calls recordFunction with the initializer node).
  const sourceLine = resolved.getStartLineNumber();
  return idFor.functionDefinition({ sourceFileId, name, sourceLine });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function enclosingClass(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) => Node.isClassDeclaration(a) || Node.isClassExpression(a)
  );
}

function classNameOf(cls: Node): string {
  if (Node.isClassDeclaration(cls)) {
    return cls.getName() ?? '<anonymous-class>';
  }
  if (Node.isClassExpression(cls)) {
    // Class expression bound to a variable picks up the variable name.
    const variable = cls.getParentIfKind(SyntaxKind.VariableDeclaration);
    return variable?.getName() ?? cls.getName() ?? '<anonymous-class>';
  }
  return '<anonymous-class>';
}
