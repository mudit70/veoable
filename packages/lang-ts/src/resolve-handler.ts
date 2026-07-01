import * as path from 'node:path';
import { Node, type Expression } from 'ts-morph';
import { idFor } from '@adorable/schema';
import { recordConfidenceDecision } from '@adorable/observability';
import type { TsVisitContext } from './framework-visitor.js';
import { resolveIdentifierTypeToDeclaration } from './cross-file-resolver.js';

/**
 * Shared handler resolution utilities for framework visitors.
 *
 * Several HTTP framework visitors (Express, Koa, Hono, Hapi, etc.)
 * need to resolve a handler expression (the last argument to a route
 * declaration) to a `FunctionDefinition.id`. The logic is identical
 * across frameworks — only the confidence-decision label differs.
 *
 * This module extracts that shared logic so each visitor can call
 * `resolveHandlerToFunctionId(expr, call, ctx, framework)` instead
 * of duplicating ~150 lines of resolution code.
 */

/**
 * Resolve a handler expression to a `FunctionDefinition.id`.
 *
 * Handles:
 *   - Inline arrow / function expression → null (not a named FunctionDefinition)
 *   - Identifier → resolve symbol to same-file or cross-file declaration
 *   - Anything else → null
 *
 * @param handlerExpr The expression to resolve (typically the last arg of a route call,
 *                    or a JSX attribute's identifier value)
 * @param siteNode The reference site (CallExpression for routing frameworks,
 *                 JsxAttribute for React) — used for source-line diagnostics
 *                 and same-file comparison.
 * @param ctx The visitor context
 * @param framework Framework name for confidence-decision labels (e.g. 'express', 'koa', 'react')
 */
export function resolveHandlerToFunctionId(
  handlerExpr: Expression,
  siteNode: Node,
  ctx: TsVisitContext,
  framework: string,
): string | null {
  if (Node.isArrowFunction(handlerExpr) || Node.isFunctionExpression(handlerExpr)) {
    return null;
  }
  if (!Node.isIdentifier(handlerExpr)) return null;

  // #200 — type-checker-first: ask the TS type checker for the
  // resolved declaration. This succeeds across path-mapped imports,
  // namespace re-exports, and `export *` chains that the syntactic
  // walk below misses. Two guards keep the result consistent with
  // what the structural extractor produced:
  //   1. Skip overload signatures (no body) — only the implementation
  //      gets a FunctionDefinition node, so its line is what we need
  //      for id equality.
  //   2. Skip declarations in `.d.ts` / node_modules — those files
  //      aren't extracted, so emitting an edge to a synthetic
  //      sourceFileId there produces a dangling reference.
  const tcResolved = resolveIdentifierTypeToDeclaration(handlerExpr, (d) => {
    if (!unwrapToFunctionShape(d)) return false;
    if (Node.isFunctionDeclaration(d) && !d.hasBody()) return false;
    return true;
  });
  if (tcResolved) {
    const fnNode = unwrapToFunctionShape(tcResolved);
    if (fnNode) {
      const targetSourceFile = fnNode.getSourceFile();
      const inExternal = targetSourceFile.isInNodeModules() || targetSourceFile.isFromExternalLibrary();
      if (!inExternal) {
        const tcName = nameForFunctionDeclaration(tcResolved, fnNode);
        if (tcName) {
          const sourceFileId = targetSourceFile === siteNode.getSourceFile()
            ? ctx.sourceFile.id
            : idFor.sourceFile({
              repository: ctx.repository,
              filePath: path
                .relative(ctx.rootDir, targetSourceFile.getFilePath())
                .split(path.sep)
                .join('/'),
            });
          return idFor.functionDefinition({
            sourceFileId,
            name: tcName,
            sourceLine: fnNode.getStartLineNumber(),
          });
        }
      }
    }
  }

  const symbol = handlerExpr.getSymbol();
  if (!symbol) {
    // JSX call-sites fan out by 10-100x relative to routing
    // frameworks (every JSX attribute on every component) — emit
    // confidence decisions only for the lower-cardinality
    // routing-framework callers to keep observability legible.
    if (!Node.isJsxAttribute(siteNode)) {
      recordConfidenceDecision(`${framework} handler identifier did not resolve`, {
        [`${framework}.handler`]: handlerExpr.getText(),
        'call.sourceLine': siteNode.getStartLineNumber(),
      });
    }
    return null;
  }
  const decls = symbol.getDeclarations();
  if (decls.length === 0) return null;

  const decl = decls[0];

  // Cross-file resolution: follow imports to the target module.
  if (
    Node.isImportSpecifier(decl) ||
    Node.isImportClause(decl) ||
    Node.isNamespaceImport(decl)
  ) {
    return resolveCrossFileHandler(decl, handlerExpr, siteNode, ctx, framework);
  }

  // Same-file resolution.
  const fnNode = unwrapToFunctionShape(decl);
  if (!fnNode) return null;
  if (fnNode.getSourceFile() !== siteNode.getSourceFile()) return null;

  const name = nameForFunctionDeclaration(decl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

/**
 * Resolve a handler that is imported from another file. Follows the
 * import declaration to the target module, finds the exported function,
 * and computes its `FunctionDefinition` id using the target file's
 * repository-relative path.
 */
function resolveCrossFileHandler(
  importDecl: Node,
  handlerExpr: Expression,
  siteNode: Node,
  ctx: TsVisitContext,
  framework: string,
): string | null {
  let targetFile;
  try {
    let current = importDecl as Node;
    while (current && !Node.isImportDeclaration(current)) {
      current = current.getParent() as Node;
    }
    if (!current || !Node.isImportDeclaration(current)) return null;
    targetFile = current.getModuleSpecifierSourceFile();
  } catch {
    return null;
  }

  if (!targetFile) {
    if (!Node.isJsxAttribute(siteNode)) {
      recordConfidenceDecision(`${framework} handler import target not resolved`, {
        [`${framework}.handler`]: handlerExpr.getText(),
        'call.sourceLine': siteNode.getStartLineNumber(),
      });
    }
    return null;
  }

  const targetFilePath = path.relative(ctx.rootDir, targetFile.getFilePath()).split(path.sep).join('/');
  const targetSourceFileId = idFor.sourceFile({
    repository: ctx.repository,
    filePath: targetFilePath,
  });

  const handlerName = handlerExpr.getText();
  const targetSymbol = targetFile.getExportedDeclarations().get(handlerName);
  if (!targetSymbol || targetSymbol.length === 0) return null;

  const targetDecl = targetSymbol[0];
  const fnNode = unwrapToFunctionShape(targetDecl);
  if (!fnNode) return null;

  const name = nameForFunctionDeclaration(targetDecl, fnNode);
  if (!name) return null;

  return idFor.functionDefinition({
    sourceFileId: targetSourceFileId,
    name,
    sourceLine: fnNode.getStartLineNumber(),
  });
}

/**
 * Derive the canonical function name the structural extractor would
 * have used for this declaration:
 *   - function declaration → declared name
 *   - variable bound to arrow/fn-expr → variable name
 */
function nameForFunctionDeclaration(decl: Node, fnNode: Node): string | null {
  if (Node.isFunctionDeclaration(fnNode)) return fnNode.getName() ?? null;
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  return null;
}

/**
 * Resolve a declaration node to the function-shaped node it backs.
 * Handles two shapes:
 *   - the declaration is itself function-shaped → return it
 *   - the declaration is a `VariableDeclaration` whose initializer
 *     is an arrow or function expression → return the initializer
 */
function unwrapToFunctionShape(decl: Node): Node | null {
  if (
    Node.isFunctionDeclaration(decl) ||
    Node.isMethodDeclaration(decl) ||
    Node.isArrowFunction(decl) ||
    Node.isFunctionExpression(decl)
  ) {
    return decl;
  }
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer;
    }
  }
  return null;
}
