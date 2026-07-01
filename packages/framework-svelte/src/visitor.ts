import { Node, SyntaxKind } from 'ts-morph';
import { idFor, type APIEndpoint, type ClientSideProcess, type ProcessKind } from '@adorable/schema';
import { type TsFrameworkVisitor, buildEvidence } from '@adorable/lang-ts';

/**
 * Svelte/SvelteKit framework visitor (#59).
 *
 * Detects:
 *  1. **Svelte lifecycle hooks** — `onMount`, `onDestroy`, `beforeUpdate`,
 *     `afterUpdate` call expressions. Yields `ClientSideProcess` with
 *     `kind: 'lifecycle_hook'`.
 *
 *  2. **SvelteKit load functions** — exported `load` function in files
 *     matching `+page.ts`, `+page.server.ts`, `+layout.ts`,
 *     `+layout.server.ts`. Yields `APIEndpoint` with `method: 'GET'`.
 *
 *  3. **SvelteKit form actions** — exported `actions` object in
 *     `+page.server.ts` files. Each property of the actions object
 *     yields an `APIEndpoint` with `method: 'POST'`.
 *
 *  4. **Svelte store subscriptions** — `.subscribe()` calls, similar
 *     to Angular/RxJS. Yields `ClientSideProcess` with
 *     `kind: 'state_observer'`.
 */

const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
  'onMount',
  'onDestroy',
  'beforeUpdate',
  'afterUpdate',
]);

const SVELTEKIT_ROUTE_FILES = /\+(?:page|layout)(?:\.server)?\.ts$/;

export function createSvelteVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',
    onNode(ctx, node) {
      const filePath = ctx.sourceFile.filePath;

      // ── Svelte lifecycle hook calls ────────────────────────────────
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (Node.isIdentifier(callee)) {
          const hookName = callee.getText();

          if (LIFECYCLE_HOOKS.has(hookName)) {
            if (!ctx.enclosingFunction) return;

            const process: ClientSideProcess = {
              nodeType: 'ClientSideProcess',
              id: idFor.clientSideProcess({
                sourceFileId: ctx.sourceFile.id,
                sourceLine: node.getStartLineNumber(),
                name: hookName,
              }),
              kind: 'lifecycle_hook',
              name: hookName,
              functionId: ctx.enclosingFunction.id,
              sourceFileId: ctx.sourceFile.id,
              sourceLine: node.getStartLineNumber(),
              framework: 'svelte',
              repository: ctx.sourceFile.repository,
              evidence: buildEvidence(node, ctx.sourceFile.filePath),
            };
            ctx.emitNode(process);
            return;
          }
        }

        // ── Store subscribe calls ──────────────────────────────────
        if (Node.isPropertyAccessExpression(callee)) {
          const methodName = callee.getNameNode().getText();
          if (methodName === 'subscribe') {
            if (!ctx.enclosingFunction) return;

            const process: ClientSideProcess = {
              nodeType: 'ClientSideProcess',
              id: idFor.clientSideProcess({
                sourceFileId: ctx.sourceFile.id,
                sourceLine: node.getStartLineNumber(),
                name: 'subscribe',
              }),
              kind: 'state_observer',
              name: 'subscribe',
              functionId: ctx.enclosingFunction.id,
              sourceFileId: ctx.sourceFile.id,
              sourceLine: node.getStartLineNumber(),
              framework: 'svelte',
              repository: ctx.sourceFile.repository,
              evidence: buildEvidence(node, ctx.sourceFile.filePath),
            };
            ctx.emitNode(process);
            return;
          }
        }
      }

      // ── SvelteKit load functions ───────────────────────────────────
      if (SVELTEKIT_ROUTE_FILES.test(filePath)) {
        // Exported function load() or export const load = ...
        if (Node.isFunctionDeclaration(node)) {
          const name = node.getName();
          if (name === 'load' && node.isExported()) {
            emitLoadEndpoint(node, ctx);
            return;
          }
        }

        if (Node.isVariableDeclaration(node)) {
          const name = node.getName();

          if (name === 'load') {
            const varStmt = node.getParent()?.getParent();
            if (varStmt && Node.isVariableStatement(varStmt) && varStmt.isExported()) {
              emitLoadEndpoint(node, ctx);
              return;
            }
          }

          // SvelteKit form actions: export const actions = { default: ..., delete: ... }
          if (name === 'actions') {
            const varStmt = node.getParent()?.getParent();
            if (varStmt && Node.isVariableStatement(varStmt) && varStmt.isExported()) {
              emitFormActions(node, ctx);
              return;
            }
          }
        }
      }
    },
  };
}

/**
 * Derive the route pattern from a SvelteKit route file path.
 *
 * SvelteKit uses directory-based routing:
 *   src/routes/users/+page.ts → /users
 *   src/routes/users/[id]/+page.ts → /users/:id
 *   src/routes/+page.ts → /
 *
 * Note: The `[param]` → `:param` normalization logic overlaps with
 * `@adorable/framework-remix/route-convention.ts`. The conventions
 * themselves differ (SvelteKit uses directories, Remix uses flat files)
 * so they are kept separate, but the normalization could be consolidated
 * into a shared utility in the future.
 */
function filePathToRoutePattern(filePath: string): string {
  // Find the routes directory
  const routesIdx = filePath.indexOf('routes/');
  if (routesIdx === -1) return '/';

  let routePath = filePath.slice(routesIdx + 'routes/'.length);

  // Remove the +page.ts / +layout.ts filename
  const lastSlash = routePath.lastIndexOf('/');
  if (lastSlash >= 0) {
    routePath = routePath.slice(0, lastSlash);
  } else {
    return '/';
  }

  // Convert SvelteKit [param] to :param
  routePath = routePath.replace(/\[\.\.\.(\w+)\]/g, '*');
  routePath = routePath.replace(/\[(\w+)\]/g, ':$1');

  // Strip (group) route groups
  routePath = routePath.replace(/\([^)]+\)\/?/g, '');

  return '/' + routePath.replace(/\/+$/, '');
}

function emitLoadEndpoint(
  node: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): void {
  const routePattern = filePathToRoutePattern(ctx.sourceFile.filePath);

  let handlerFunctionId: string | null = null;
  if (Node.isFunctionDeclaration(node)) {
    const fnName = node.getName();
    if (fnName) {
      handlerFunctionId = idFor.functionDefinition({
        sourceFileId: ctx.sourceFile.id,
        name: fnName,
        sourceLine: node.getStartLineNumber(),
      });
    }
  } else if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      handlerFunctionId = idFor.functionDefinition({
        sourceFileId: ctx.sourceFile.id,
        name: node.getName(),
        sourceLine: init.getStartLineNumber(),
      });
    }
  }

  const evidence = buildEvidence(node, ctx.sourceFile.filePath);
  const endpoint: APIEndpoint = {
    nodeType: 'APIEndpoint',
    id: idFor.apiEndpoint({
      repository: ctx.sourceFile.repository,
      httpMethod: 'GET',
      routePattern,
      filePath: evidence.filePath,
      lineStart: evidence.lineStart,
    }),
    httpMethod: 'GET',
    routePattern,
    handlerFunctionId,
    framework: 'sveltekit',
    repository: ctx.sourceFile.repository,
    evidence,
  };
  ctx.emitNode(endpoint);
}

function emitFormActions(
  node: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): void {
  if (!Node.isVariableDeclaration(node)) return;
  let init = node.getInitializer();
  if (!init) return;

  // Unwrap `satisfies T` and `as T` expressions to get the object literal.
  if (Node.isSatisfiesExpression(init) || Node.isAsExpression(init)) {
    init = init.getExpression();
  }
  if (!Node.isObjectLiteralExpression(init)) return;

  const routePattern = filePathToRoutePattern(ctx.sourceFile.filePath);

  for (const prop of init.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) continue;

    const actionName = Node.isPropertyAssignment(prop) ? prop.getName() : prop.getName();

    const evidence = buildEvidence(prop, ctx.sourceFile.filePath);
    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: ctx.sourceFile.repository,
        httpMethod: 'POST',
        routePattern: actionName === 'default' ? routePattern : `${routePattern}?/${actionName}`,
        filePath: evidence.filePath,
        lineStart: evidence.lineStart,
      }),
      httpMethod: 'POST',
      routePattern: actionName === 'default' ? routePattern : `${routePattern}?/${actionName}`,
      handlerFunctionId: null,
      framework: 'sveltekit',
      repository: ctx.sourceFile.repository,
      evidence,
    };
    ctx.emitNode(endpoint);
  }
}
