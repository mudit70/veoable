// Procedure built via a chained builder:
//   publicProcedure.input(schema).output(schema).query(handler)
//
// `findProcedureType` recurses through PropertyAccessExpressions
// looking for `query` / `mutation` / `subscription` at the chain's
// outermost call (visitor.ts:111–123). All four shapes below should
// emit endpoints with the right HTTP method.
import { router, publicProcedure } from '@trpc/server';

export const chainedRouter = router({
  // 1. .input(...).query(handler) — GET.
  inputThenQuery: publicProcedure
    .input({ x: 1 })
    .query((_args: unknown) => null),

  // 2. .output(...).query(handler) — GET.
  outputThenQuery: publicProcedure
    .output({ x: 1 })
    .query((_args: unknown) => null),

  // 3. .input(...).output(...).query(handler) — both, GET.
  fullChainQuery: publicProcedure
    .input({ x: 1 })
    .output({ x: 1 })
    .query((_args: unknown) => null),

  // 4. .input(...).output(...).mutation(handler) — chain ending in mutation, POST.
  fullChainMutation: publicProcedure
    .input({ x: 1 })
    .output({ x: 1 })
    .mutation((_args: unknown) => null),

  // 5. .input(...).subscription(handler) — chain ending in subscription, WS.
  chainSubscription: publicProcedure
    .input({ x: 1 })
    .subscription((_args: unknown) => null),
});
