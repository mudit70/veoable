// Shapes the visitor must NOT mistake for tRPC routers.
import { publicProcedure } from '@trpc/server';

// 1. A function called `useRouter` — common in React-Router or Next.js
//    client code. Different name; must not match.
function useRouter() {
  return { push: (_p: string) => undefined };
}
useRouter().push('/foo');

// 2. A function whose property-access ends in `.router` but the receiver
//    is NOT a tRPC builder. The visitor's `isRouterCall` matches any
//    `<X>.router(...)`, which is intentionally broad — but the call must
//    still pass an object literal as the first argument. A non-object
//    arg (here: a string) bails at line 32 of the visitor.
const notTrpc = { router: (_arg: string) => undefined };
notTrpc.router('hello');

// 3. router(notAnObject) — the visitor checks `Node.isObjectLiteralExpression`
//    and bails when the first arg is anything else.
import { router } from '@trpc/server';
const someConfig = { foo: publicProcedure.query((_a: unknown) => null) };
router(someConfig); // ← `someConfig` is an Identifier, not an object literal.

// 4. Empty object literal — no procedures, no endpoints emitted. Visitor
//    walks the empty member list and exits cleanly.
export const emptyRouter = router({});

// 5. Object property whose initializer is missing. TypeScript would reject
//    this, but the visitor's `if (!init) continue;` guards it. (Constructed
//    only as a comment — emitting an actual fixture for this would need
//    invalid TS.)
