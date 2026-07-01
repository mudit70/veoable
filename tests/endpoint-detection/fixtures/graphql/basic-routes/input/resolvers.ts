interface ResolverArgs {
  parent: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

export const resolvers = {
  Query: {
    users: (_p: ResolverArgs) => [],
    user: (_p: ResolverArgs) => null,
  },
  Mutation: {
    createUser: (_p: ResolverArgs) => null,
  },
};
