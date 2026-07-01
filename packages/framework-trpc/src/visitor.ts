import * as path from 'node:path';
import { Node } from 'ts-morph';
import { idFor, type APIEndpoint } from '@adorable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveIdentifierTypeToDeclaration,
} from '@adorable/lang-ts';

/**
 * tRPC framework visitor (#29).
 *
 * Detects tRPC procedure definitions:
 *
 *   export const appRouter = router({
 *     getUser: publicProcedure.input(...).query(handler),
 *     createUser: publicProcedure.mutation(handler),
 *     user: userRouter,  // nested router
 *   });
 *
 * Also handles `t.router({...})` and `createTRPCRouter({...})`.
 */

export function createTrpcVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isCallExpression(node)) return;

      // M3 fix: handle both `router({})` and `t.router({})` and `createTRPCRouter({})`
      if (!isRouterCall(node)) return;

      const args = node.getArguments();
      if (args.length === 0) return;
      const routerObj = args[0];
      if (!Node.isObjectLiteralExpression(routerObj)) return;

      extractProcedures(ctx, routerObj, '', 0);
    },
  };
}

/**
 * #201 — recursion-depth ceiling for `extractProcedures`. Real tRPC
 * routers nest only a handful of levels (`v1.users.posts.comments`
 * is already deeper than typical); 16 leaves enormous headroom while
 * preventing a stack overflow in the pathological case where a
 * cyclic Identifier-valued router graph (A -> B -> A) would
 * otherwise loop forever.
 *
 * A node-identity Set was tried first but regressed legitimate
 * fan-out (`router({ v1: shared, v2: shared })` would silently drop
 * the second mount because both mounts re-enter the same
 * ObjectLiteralExpression).
 */
const MAX_NESTED_ROUTER_DEPTH = 16;

function isRouterCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  if (Node.isIdentifier(callee)) {
    return callee.getText() === 'router' || callee.getText() === 'createTRPCRouter';
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getNameNode().getText() === 'router';
  }
  return false;
}

// M4 fix: extract procedures recursively, handling nested routers with prefix.
// #201 — `depth` caps recursion to prevent stack overflow on cyclic
// Identifier-valued router graphs. Legitimate same-router fan-out
// (mounting one router under multiple prefixes) is preserved.
function extractProcedures(
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  routerObj: Node,
  prefix: string,
  depth: number,
): void {
  if (!Node.isObjectLiteralExpression(routerObj)) return;
  if (depth > MAX_NESTED_ROUTER_DEPTH) return;

  for (const prop of routerObj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;

    const nameNode = prop.getNameNode();
    const procedureName = Node.isIdentifier(nameNode) ? nameNode.getText() : null;
    if (!procedureName) continue;

    const fullName = prefix ? `${prefix}.${procedureName}` : procedureName;
    const init = prop.getInitializer();
    if (!init) continue;

    // Check if this is a nested router call.
    if (Node.isCallExpression(init) && isRouterCall(init)) {
      const nestedArgs = init.getArguments();
      if (nestedArgs.length > 0) {
        extractProcedures(ctx, nestedArgs[0], fullName, depth + 1);
      }
      continue;
    }

    // #201 — Identifier-valued nested routers:
    //   import { usersRouter } from './users';
    //   const appRouter = router({ users: usersRouter });
    // Resolve the Identifier to its declaration via the type-checker
    // helper, follow to the `router({...})` call, recurse with the
    // composed prefix. Same-file references work too because the
    // resolver returns same-file declarations directly.
    if (Node.isIdentifier(init)) {
      const nestedObj = resolveIdentifierToRouterArg(init);
      if (nestedObj) {
        extractProcedures(ctx, nestedObj, fullName, depth + 1);
      }
      continue;
    }

    const procedureType = findProcedureType(init);
    if (!procedureType) continue;

    const httpMethod = procedureType === 'query' ? 'GET'
      : procedureType === 'mutation' ? 'POST'
      : 'WS';

    const routePattern = `/trpc/${fullName}`;
    const handlerFnId = resolveHandler(init, ctx, fullName);

    const evidence = buildEvidence(prop, ctx.sourceFile.filePath);
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
      handlerFunctionId: handlerFnId,
      framework: 'trpc',
      repository: ctx.sourceFile.repository,
      evidence,
    };
    ctx.emitNode(endpoint);
  }
}

// n1 fix: simplified — just check the outermost call, recurse into receiver.
function findProcedureType(node: Node): 'query' | 'mutation' | 'subscription' | null {
  if (!Node.isCallExpression(node)) return null;
  const expr = node.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;

  const method = expr.getNameNode().getText();
  if (method === 'query') return 'query';
  if (method === 'mutation') return 'mutation';
  if (method === 'subscription') return 'subscription';

  // Check receiver for chained calls like .output(schema).query(handler)
  return findProcedureType(expr.getExpression());
}

/**
 * Resolve an Identifier reference (`users: usersRouter`) to the
 * ObjectLiteralExpression argument of its declaration's
 * `router({...})` call. Walks across files via the type-checker-first
 * helper from `@adorable/lang-ts` (#200).
 *
 * Returns null when the identifier doesn't resolve to a
 * `VariableDeclaration` whose initializer is a `router(...)` /
 * `createTRPCRouter(...)` / `t.router(...)` call with an inline
 * object-literal argument.
 */
function resolveIdentifierToRouterArg(ident: Node): Node | null {
  if (!Node.isIdentifier(ident)) return null;
  const decl = resolveIdentifierTypeToDeclaration(ident, (d) => {
    if (!Node.isVariableDeclaration(d)) return false;
    const init = d.getInitializer();
    return !!init && Node.isCallExpression(init) && isRouterCall(init);
  });
  if (!decl || !Node.isVariableDeclaration(decl)) return null;
  const init = decl.getInitializer();
  if (!init || !Node.isCallExpression(init)) return null;
  const args = init.getArguments();
  if (args.length === 0) return null;
  const obj = args[0];
  if (!Node.isObjectLiteralExpression(obj)) return null;
  return obj;
}

function resolveHandler(
  node: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
  procedureName: string
): string | null {
  if (!Node.isCallExpression(node)) return null;
  const expr = node.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;

  const method = expr.getNameNode().getText();
  if (method === 'query' || method === 'mutation' || method === 'subscription') {
    const args = node.getArguments();
    if (args.length > 0) {
      const handler = args[0];
      if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
        // #201 — when the handler lives in a different file than the
        // mount site (because the parent router was an Identifier
        // resolved cross-file), root the FunctionDefinition id in the
        // handler's actual SourceFile id, not the outer mount file's
        // id. Otherwise the id won't match the FunctionDefinition the
        // language plugin emits when it processes the inner file.
        const handlerSourceFile = handler.getSourceFile();
        const sourceFileId = handlerSourceFile.getFilePath() === ctx.sourceFile.filePath
          ? ctx.sourceFile.id
          : idFor.sourceFile({
            repository: ctx.repository,
            filePath: path
              .relative(ctx.rootDir, handlerSourceFile.getFilePath())
              .split(path.sep)
              .join('/'),
          });
        return idFor.functionDefinition({
          sourceFileId,
          name: procedureName,
          sourceLine: handler.getStartLineNumber(),
        });
      }
    }
  }
  return null;
}
