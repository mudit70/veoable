import { Node } from 'ts-morph';
import { idFor, type APIEndpoint } from '@veoable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@veoable/lang-ts';
import { filePathToRoutePattern } from './route-convention.js';

/**
 * Remix framework visitor (#31).
 *
 * Detects API endpoints from Remix route files. A route file is any
 * file under `app/routes/` that exports `loader` (→ GET) or `action`
 * (→ POST) functions.
 *
 * The visitor dispatches on exported function declarations /
 * variable declarations named `loader` or `action`.
 */

const ROUTE_EXPORTS: ReadonlySet<string> = new Set(['loader', 'action']);

export function createRemixVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      const filePath = ctx.sourceFile.filePath;

      // Only process files under app/routes/
      if (!filePath.includes('app/routes/')) return;

      const routePattern = filePathToRoutePattern(filePath);
      if (!routePattern) return;

      // Detect exported function declarations: export function loader(...) / export async function loader(...)
      if (Node.isFunctionDeclaration(node)) {
        const name = node.getName();
        if (!name || !ROUTE_EXPORTS.has(name)) return;
        if (!node.isExported()) return;

        emitEndpoint(name, routePattern, ctx, node);
        return;
      }

      // Detect exported variable declarations: export const loader = async (...) => { ... }
      if (Node.isVariableDeclaration(node)) {
        const name = node.getName();
        if (!ROUTE_EXPORTS.has(name)) return;

        // Check if the variable statement is exported
        const varStmt = node.getParent()?.getParent();
        if (!varStmt || !Node.isVariableStatement(varStmt)) return;
        if (!varStmt.isExported()) return;

        emitEndpoint(name, routePattern, ctx, node);
        return;
      }
    },
  };
}

function emitEndpoint(
  exportName: string,
  routePattern: string,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  astNode: Node,
): void {
  // loader → GET, action → POST (Remix convention).
  // Note: Remix actions handle all non-GET methods (POST, PUT, PATCH,
  // DELETE), but we emit POST as the canonical method since it is the
  // most common and the action function itself determines behavior
  // based on request.method internally.
  const httpMethod = exportName === 'loader' ? 'GET' : 'POST';

  // Resolve handler function id
  let handlerFunctionId: string | null = null;
  if (Node.isFunctionDeclaration(astNode)) {
    const fnName = astNode.getName();
    if (fnName) {
      handlerFunctionId = idFor.functionDefinition({
        sourceFileId: ctx.sourceFile.id,
        name: fnName,
        sourceLine: astNode.getStartLineNumber(),
      });
    }
  } else if (Node.isVariableDeclaration(astNode)) {
    const init = astNode.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      handlerFunctionId = idFor.functionDefinition({
        sourceFileId: ctx.sourceFile.id,
        name: astNode.getName(),
        sourceLine: init.getStartLineNumber(),
      });
    }
  }

  const evidence = buildEvidence(astNode, ctx.sourceFile.filePath);
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod,
      routePattern,
      filePath: evidence.filePath,
      lineStart: evidence.lineStart,
    }),
    httpMethod,
    routePattern,
    handlerFunctionId,
    framework: 'remix',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}
