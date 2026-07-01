// Flat router via the bare `router(...)` import shape.
//
// Visitor expectations (per packages/framework-trpc/src/visitor.ts):
//   - `router({ ... })` matches `isRouterCall`.
//   - Each property whose initializer ends in `.query()` / `.mutation()` /
//     `.subscription()` becomes one APIEndpoint at `/trpc/<key>`.
//   - HTTP method: query → GET, mutation → POST, subscription → WS.
//   - Inline arrow handlers resolve `handlerFunctionId`.
import { router, publicProcedure } from '@trpc/server';

export const appRouter = router({
  // .query(handler) — inline arrow → resolved handlerFunctionId, GET.
  getUser: publicProcedure.query((_args: unknown) => ({ id: 1, name: 'a' })),

  // .mutation(handler) — inline arrow → resolved handlerFunctionId, POST.
  createUser: publicProcedure.mutation((_args: unknown) => ({ id: 1 })),

  // .subscription(handler) — WS.
  watchUser: publicProcedure.subscription((_args: unknown) => null),
});
