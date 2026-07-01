// Standard code-first GraphQL resolver map.
//
// Visitor expectations (per packages/framework-graphql/src/visitor.ts):
//   - The PropertyAssignment for `Query` / `Mutation` / `Subscription` is
//     detected when the parent object literal has at least 2 GraphQL-type
//     siblings (the anti-Redux-store guard at lines 45-49) OR when the
//     enclosing variable / property name contains "resolver" (lines 53-59).
//   - Each property of the type's value object becomes one APIEndpoint:
//       Query → GET /graphql/Query/<name>
//       Mutation → POST /graphql/Mutation/<name>
//       Subscription → WS /graphql/Subscription/<name>
//   - Inline arrow / function expression resolvers AND method declarations
//     resolve `handlerFunctionId`. Shorthand and Identifier-valued
//     properties leave it as null (#202 — pinned below).

interface ResolverArgs {
  parent: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

// Multi-type case — passes the anti-Redux guard via sibling count.
export const resolvers = {
  Query: {
    // Property assignment with arrow → resolved.
    users: (_p: ResolverArgs) => [],
    // Property assignment with arrow → resolved.
    user: (_p: ResolverArgs) => null,
  },
  Mutation: {
    // Method declaration → resolved.
    createUser(_p: ResolverArgs) {
      return null;
    },
  },
  Subscription: {
    userUpdated: (_p: ResolverArgs) => null,
  },
};
