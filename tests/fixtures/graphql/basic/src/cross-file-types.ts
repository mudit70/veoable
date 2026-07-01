// Pin for #200: graphql visitor at visitor.ts:66 bails when the
// value of `Query` / `Mutation` / `Subscription` is an Identifier
// rather than an ObjectLiteralExpression. Today, this codebase shape
// — common in real apps that split resolvers by type into separate
// files — produces zero endpoints for the Identifier-valued types.
//
// Sibling types whose value IS an inline ObjectLiteral still emit
// normally, demonstrating the partial-emission failure mode.
import { queryResolvers } from './cross-file-query.js';

interface ResolverArgs {
  parent: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

export const resolvers = {
  // Identifier-valued type — emits ZERO `/graphql/Query/*` endpoints.
  // When #200's type-checker-first cross-file resolution lands, the
  // visitor will be able to follow `queryResolvers` to its declaration
  // and walk it the same way it walks an inline ObjectLiteral.
  Query: queryResolvers,

  // Sibling that IS an inline ObjectLiteral — emits normally so this
  // file produces SOME endpoints overall (and the anti-Redux-store
  // sibling-count guard passes).
  Mutation: {
    createUser: (_p: ResolverArgs) => null,
  },
};
