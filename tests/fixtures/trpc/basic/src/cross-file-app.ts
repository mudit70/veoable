// #201 — mounts a cross-file Identifier-valued nested router. The
// visitor must follow `usersRouter` to its declaration in
// `./cross-file-users.ts` and emit `/trpc/users.list` and
// `/trpc/users.create`.
import { router, publicProcedure } from '@trpc/server';
import { usersRouter } from './cross-file-users.js';

export const appRouter = router({
  users: usersRouter,
  health: publicProcedure.query((_args: unknown) => 'ok'),
});
