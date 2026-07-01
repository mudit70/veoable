// Resolver map for the Query type, defined in its own file. The
// idiomatic shape in scaled codebases — splitting resolvers by type so
// each file is small.
interface ResolverArgs {
  parent: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

export const queryResolvers = {
  users: (_p: ResolverArgs) => [],
  user: (_p: ResolverArgs) => null,
};
