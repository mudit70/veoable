// #201 — true cross-file router declared in this module, mounted by
// `cross-file-app.ts`.
import { router, publicProcedure } from '@trpc/server';

export const usersRouter = router({
  list: publicProcedure.query((_args: unknown) => []),
  create: publicProcedure.mutation((_args: unknown) => ({ id: 1 })),
});
