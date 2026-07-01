// Handler resolution behavior.
//
// `resolveHandler` (visitor.ts:125–149) returns a non-null
// `handlerFunctionId` ONLY when the .query/.mutation/.subscription
// argument is an inline ArrowFunction or FunctionExpression. Other
// shapes (Identifier, MethodReference) return null today.
//
// This pins the #201 gap: idiomatic tRPC code factors handlers out as
// named functions and references them by Identifier. Today those emit
// the endpoint but with `handlerFunctionId: null`. When #201 lands the
// pin will need to flip; until then this test keeps any unrelated
// refactor from silently changing the resolution behavior.
import { router, publicProcedure } from '@trpc/server';

// Same-file named handler.
export function namedHandler(_args: unknown) {
  return { ok: true };
}

// Same-file arrow bound to a const.
export const arrowConstHandler = (_args: unknown) => ({ ok: true });

export const handlerRouter = router({
  // Inline arrow — resolves.
  inline: publicProcedure.query((_args: unknown) => ({ ok: true })),

  // Inline function expression — resolves.
  inlineFnExpr: publicProcedure.query(function (_args: unknown) {
    return { ok: true };
  }),

  // Identifier-valued handler — emits endpoint, handlerFunctionId null. (#201)
  identifierHandler: publicProcedure.query(namedHandler),

  // Variable-bound arrow as Identifier — also null today (Identifier path). (#201)
  arrowConstAsIdentifier: publicProcedure.query(arrowConstHandler),
});
