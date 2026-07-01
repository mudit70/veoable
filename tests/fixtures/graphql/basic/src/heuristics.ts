// The visitor's anti-false-positive heuristics (visitor.ts:45-63):
//   1. If the parent object has 2+ GraphQL-type siblings (Query +
//      Mutation, etc.) → match.
//   2. If only 1 GraphQL-type sibling, fall back to a name check on
//      the enclosing variable or property: matches when the name
//      contains "resolver" (case-insensitive).
//   3. Otherwise → skip (single GraphQL type in non-resolver context).
//
// This file exercises each branch.

interface ResolverArgs {
  parent: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

// CASE A: single GraphQL type, enclosing variable named "*resolver*" → match.
export const userResolvers = {
  Query: {
    users: (_p: ResolverArgs) => [],
  },
};

// CASE B: single GraphQL type, enclosing variable name does NOT contain
// "resolver" (and no sibling) — visitor skips.
//
// This is the Redux-store collision case the heuristic was designed to
// guard against:
//   `const userSlice = { Query: someReducer }` — the literal `Query` is
//   coincidental, not a GraphQL resolver.
export const userSlice = {
  Query: {
    pendingFetches: 0, // not even a function — just structural overlap
  },
};

// CASE C: single GraphQL type, but nested under a property named
// "resolvers". Visitor walks grandparent at lines 56-59 and matches.
export const schema = {
  resolvers: {
    Query: {
      products: (_p: ResolverArgs) => [],
    },
  },
};

// CASE D: object literal with both Query and Mutation siblings — passes
// the anti-Redux guard at lines 45-49 directly, no name fallback needed.
export const fullResolvers = {
  Query: {
    health: (_p: ResolverArgs) => 'ok',
  },
  Mutation: {
    ping: (_p: ResolverArgs) => 'pong',
  },
};
