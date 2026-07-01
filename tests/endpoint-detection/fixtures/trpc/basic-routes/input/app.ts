import { router, publicProcedure } from '@trpc/server';

export const appRouter = router({
  getUser: publicProcedure.query((_args: unknown) => ({ id: 1 })),
  createUser: publicProcedure.mutation((_args: unknown) => ({ id: 1 })),
  watchUser: publicProcedure.subscription((_args: unknown) => null),
});
