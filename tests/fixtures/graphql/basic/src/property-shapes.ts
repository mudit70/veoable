// All three resolver-property shapes the visitor handles.
//
// Visitor (lines 76-98 in visitor.ts):
//   - PropertyAssignment with ArrowFunction / FunctionExpression init
//     → handlerFunctionId resolved.
//   - PropertyAssignment with Identifier init → handlerFunctionId null. (#202)
//   - MethodDeclaration → handlerFunctionId resolved.
//   - ShorthandPropertyAssignment → handlerFunctionId null. (#202)

interface ResolverArgs {
  parent: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

// Same-file named resolver — used by both the Identifier-valued and
// shorthand cases below.
export const usersResolver = (_p: ResolverArgs) => [];

// Multi-type to satisfy the anti-Redux guard.
export const resolvers = {
  Query: {
    // 1. PropertyAssignment with arrow → resolves.
    inline: (_p: ResolverArgs) => null,
    // 2. PropertyAssignment with function expression → resolves.
    inlineFnExpr: function (_p: ResolverArgs) {
      return null;
    },
    // 3. MethodDeclaration → resolves.
    methodDecl(_p: ResolverArgs) {
      return null;
    },
    // 4. PropertyAssignment with Identifier → handlerFunctionId null (#202).
    identifierResolver: usersResolver,
    // 5. Shorthand property assignment → handlerFunctionId null (#202).
    usersResolver,
  },
  Mutation: {
    // Sibling Mutation just to satisfy the guard.
    noop: (_p: ResolverArgs) => null,
  },
};
