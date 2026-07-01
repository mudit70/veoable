// Nested router with prefix-flattening.
//
// `router({ users: router({ list, create }) })` should produce
// APIEndpoints at `/trpc/users.list` and `/trpc/users.create`.
//
// Identifier-valued nested router (`router({ users: usersRouter })`) is
// a known gap (visitor.ts:80–81 explicitly comments "skip them"). The
// test for this case PINS the current null-emit behavior so the
// fixture/test pair will catch any change — including the eventual
// fix from #200's cross-file resolution work.
import { router, publicProcedure } from '@trpc/server';

// Inline-nested shape — fully resolved.
export const inlineNested = router({
  users: router({
    list: publicProcedure.query((_args: unknown) => []),
    create: publicProcedure.mutation((_args: unknown) => ({ id: 1 })),
  }),
});

// Pin the cross-file gap: nested router via Identifier.
// `router({ users: usersRouter })` does not recurse today — `usersRouter`
// is an Identifier, not a CallExpression matching `isRouterCall`, so the
// `extractProcedures` recursion is skipped and zero endpoints are emitted
// for `users.list` / `users.create`. The test asserts this current
// behavior; it will need to flip when #200 lands.
export const usersRouter = router({
  list: publicProcedure.query((_args: unknown) => []),
  create: publicProcedure.mutation((_args: unknown) => ({ id: 1 })),
});

export const referencedNested = router({
  // Identifier value — currently produces no `users.*` endpoints.
  users: usersRouter,
  // Sibling that DOES resolve — inline call → emits.
  posts: router({
    list: publicProcedure.query((_args: unknown) => []),
  }),
});

// #201 — same-router fan-out: mounting one router under two prefixes
// must produce TWO sets of endpoints, not silently drop the second.
export const versionedAPI = router({
  v1: usersRouter,
  v2: usersRouter,
});
