import * as path from 'node:path';
import { Node, type ObjectLiteralExpression } from 'ts-morph';
import { idFor, type APIEndpoint } from '@adorable/schema';
import {
  type TsFrameworkVisitor,
  buildEvidence,
  resolveIdentifierTypeToDeclaration,
} from '@adorable/lang-ts';

/**
 * GraphQL framework visitor (#30).
 *
 * Detects GraphQL resolver definitions in code-first approaches:
 *
 *   const resolvers = {
 *     Query: {
 *       users: (parent, args, ctx) => { ... },
 *       user: (parent, { id }, ctx) => { ... },
 *     },
 *     Mutation: {
 *       createUser: (parent, args, ctx) => { ... },
 *     },
 *   };
 *
 * Each resolver becomes an APIEndpoint:
 *   Query → GET /graphql/Query/<name>
 *   Mutation → POST /graphql/Mutation/<name>
 *   Subscription → WS /graphql/Subscription/<name>
 */

const GRAPHQL_TYPES = new Set(['Query', 'Mutation', 'Subscription']);

export function createGraphqlVisitor(): TsFrameworkVisitor {
  return {
    language: 'ts',

    onNode(ctx, node) {
      if (!Node.isPropertyAssignment(node)) return;

      const nameNode = node.getNameNode();
      if (!Node.isIdentifier(nameNode)) return;
      const typeName = nameNode.getText();
      if (!GRAPHQL_TYPES.has(typeName)) return;

      // M1 fix: Verify this is likely a GraphQL resolver object by checking
      // the parent object has at least one sibling that is also a GraphQL type.
      // This filters out coincidental { Query: {...} } in Redux stores, etc.
      const parentObj = node.getParent();
      if (!parentObj || !Node.isObjectLiteralExpression(parentObj)) return;
      const siblingTypeCount = parentObj.getProperties().filter((p) => {
        if (!Node.isPropertyAssignment(p)) return false;
        const pName = p.getNameNode();
        return Node.isIdentifier(pName) && GRAPHQL_TYPES.has(pName.getText());
      }).length;
      // Require at least 1 GraphQL type sibling (e.g., both Query and Mutation)
      // OR the parent is assigned to a variable containing "resolver" in its name.
      if (siblingTypeCount < 2) {
        const grandparent = parentObj.getParent();
        if (Node.isVariableDeclaration(grandparent)) {
          const varName = grandparent.getName().toLowerCase();
          if (!varName.includes('resolver')) return;
        } else if (Node.isPropertyAssignment(grandparent)) {
          const propName = grandparent.getName?.().toLowerCase() ?? '';
          if (!propName.includes('resolver')) return;
        } else {
          return; // Single GraphQL type in non-resolver context — skip
        }
      }

      const init = node.getInitializer();
      if (!init) return;

      // #202 — Gap B: type init is an Identifier referencing an
      // imported resolver map. Follow it cross-file to the
      // ObjectLiteralExpression and continue with the same loop.
      let resolversObj: ObjectLiteralExpression | null = null;
      if (Node.isObjectLiteralExpression(init)) {
        resolversObj = init;
      } else if (Node.isIdentifier(init)) {
        resolversObj = resolveIdentifierToObjectLiteral(init);
      }
      if (!resolversObj) return;

      const httpMethod = typeName === 'Query' ? 'GET'
        : typeName === 'Mutation' ? 'POST'
        : 'WS';

      for (const resolverProp of resolversObj.getProperties()) {
        let resolverName: string | null = null;
        let handlerFnId: string | null = null;

        if (Node.isPropertyAssignment(resolverProp)) {
          resolverName = resolverProp.getNameNode().getText();
          const handler = resolverProp.getInitializer();
          if (handler && (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
            handlerFnId = idFor.functionDefinition({
              sourceFileId: ctx.sourceFile.id,
              name: `${typeName}.${resolverName}`,
              sourceLine: handler.getStartLineNumber(),
            });
          } else if (handler && Node.isIdentifier(handler)) {
            // #202 — Gap A: PropertyAssignment with Identifier value.
            // Resolve `users: usersResolver` to its function decl.
            handlerFnId = resolveResolverIdentifierToFunctionId(handler, ctx);
          }
        } else if (Node.isMethodDeclaration(resolverProp)) {
          // n2 fix: use getName() directly instead of `as any` cast
          resolverName = resolverProp.getName();
          handlerFnId = idFor.functionDefinition({
            sourceFileId: ctx.sourceFile.id,
            name: `${typeName}.${resolverName}`,
            sourceLine: resolverProp.getStartLineNumber(),
          });
        } else if (Node.isShorthandPropertyAssignment(resolverProp)) {
          // M2 fix: handle shorthand { users } → same as { users: users }.
          // #202 — Gap A: resolve via the value-symbol (not the
          // property-name's symbol; in shorthand the name and value
          // share the same identifier text but reference different
          // symbols).
          resolverName = resolverProp.getNameNode().getText();
          handlerFnId = resolveShorthandValueToFunctionId(resolverProp, ctx);
        }

        if (!resolverName) continue;

        const evidence = buildEvidence(resolverProp, ctx.sourceFile.filePath);
        const endpoint: APIEndpoint = {
          nodeType: 'APIEndpoint',
          id: idFor.apiEndpoint({
            repository: ctx.sourceFile.repository,
            httpMethod,
            routePattern: `/graphql/${typeName}/${resolverName}`,
            filePath: evidence.filePath,
            lineStart: evidence.lineStart,
          }),
          httpMethod,
          routePattern: `/graphql/${typeName}/${resolverName}`,
          handlerFunctionId: handlerFnId,
          framework: 'graphql',
          repository: ctx.sourceFile.repository,
          evidence,
        };
        ctx.emitNode(endpoint);
      }
    },
  };
}

/**
 * #202 — Gap B: follow `Query: queryResolvers` (Identifier value)
 * cross-file to the resolver map's ObjectLiteralExpression. Returns
 * null if the identifier doesn't resolve to a VariableDeclaration
 * with an inline object-literal initializer.
 */
function resolveIdentifierToObjectLiteral(ident: Node): ObjectLiteralExpression | null {
  if (!Node.isIdentifier(ident)) return null;
  const decl = resolveIdentifierTypeToDeclaration(ident, (d) => {
    if (!Node.isVariableDeclaration(d)) return false;
    const i = d.getInitializer();
    return !!i && Node.isObjectLiteralExpression(i);
  });
  if (!decl || !Node.isVariableDeclaration(decl)) return null;
  const i = decl.getInitializer();
  if (!i || !Node.isObjectLiteralExpression(i)) return null;
  return i;
}

/**
 * #202 — shorthand `{ usersResolver }` Gap A specialization.
 *
 * In shorthand-property-assignment, the property's name node is an
 * Identifier whose `getSymbol()` returns the property-symbol — NOT
 * the symbol of the referenced variable in the surrounding scope.
 * ts-morph exposes `getValueSymbol()` for that distinction. Going
 * through the value symbol is required for shorthand resolution
 * to find the function declaration.
 */
function resolveShorthandValueToFunctionId(
  prop: import('ts-morph').ShorthandPropertyAssignment,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  const valueSym = prop.getValueSymbol();
  if (!valueSym) return null;
  const aliased = (() => {
    try { return valueSym.getAliasedSymbol(); } catch { return undefined; }
  })();
  const target = aliased ?? valueSym;
  for (const decl of target.getDeclarations()) {
    const id = functionDefinitionIdFromDeclaration(decl, ctx);
    if (id) return id;
  }
  return null;
}

/**
 * #202 — Gap A: resolve an Identifier-valued resolver
 * (`{ users }` or `{ users: usersResolver }`) to its underlying
 * function declaration, returning the canonical FunctionDefinition
 * id rooted in the handler's actual SourceFile (cross-file aware).
 */
function resolveResolverIdentifierToFunctionId(
  ident: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  if (!Node.isIdentifier(ident)) return null;
  const decl = resolveIdentifierTypeToDeclaration(ident, (d) => {
    if (Node.isFunctionDeclaration(d)) return d.hasBody();
    if (Node.isVariableDeclaration(d)) {
      const i = d.getInitializer();
      return !!i && (Node.isArrowFunction(i) || Node.isFunctionExpression(i));
    }
    return false;
  });
  if (!decl) return null;
  return functionDefinitionIdFromDeclaration(decl, ctx);
}

/**
 * Shared: given a function-shaped declaration, compute the canonical
 * FunctionDefinition id rooted in its actual SourceFile. Returns null
 * for declarations the structural extractor wouldn't emit (overload
 * signatures, declarations in node_modules / .d.ts).
 */
function functionDefinitionIdFromDeclaration(
  decl: Node,
  ctx: Parameters<TsFrameworkVisitor['onNode']>[0],
): string | null {
  let fnNode: Node | null = null;
  let nameForId: string | null = null;
  if (Node.isFunctionDeclaration(decl)) {
    if (!decl.hasBody()) return null;
    fnNode = decl;
    nameForId = decl.getName() ?? null;
  } else if (Node.isVariableDeclaration(decl)) {
    const i = decl.getInitializer();
    if (i && (Node.isArrowFunction(i) || Node.isFunctionExpression(i))) {
      fnNode = i;
      nameForId = decl.getName();
    }
  }
  if (!fnNode || !nameForId) return null;

  const handlerSourceFile = fnNode.getSourceFile();
  if (handlerSourceFile.isInNodeModules() || handlerSourceFile.isFromExternalLibrary()) return null;

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
    name: nameForId,
    sourceLine: fnNode.getStartLineNumber(),
  });
}
