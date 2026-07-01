// Three router-call entry shapes the visitor accepts:
//   1. bare `router(...)` (already covered by flat-router.ts)
//   2. `t.router(...)` — property-access whose name is `router`
//   3. `createTRPCRouter(...)` — bare identifier with that exact name
//
// All three should produce APIEndpoints under `/trpc/<key>`.
import { initTRPC, createTRPCRouter, publicProcedure } from '@trpc/server';

const t = initTRPC.create();

// Shape 2: `t.router({...})` via property-access on the initTRPC builder.
export const tRouter = t.router({
  greet: publicProcedure.query((_args: unknown) => 'hi'),
});

// Shape 3: createTRPCRouter wrapper (also a bare identifier in the visitor's eyes).
export const createTrpcRouterShape = createTRPCRouter({
  ping: publicProcedure.query((_args: unknown) => 'pong'),
});
