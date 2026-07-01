// Ambient declaration of `@trpc/server` so fixture files can import the
// boilerplate the way real tRPC code does. The trpc visitor matches by
// AST text (callee identifier name) rather than by type; the stubs only
// need to be enough for the TypeScript compiler to accept the fixtures.
declare module '@trpc/server' {
  // Procedure builder — input/output schemas accept anything; .query /
  // .mutation / .subscription accept any handler.
  export interface ProcedureBuilder {
    input(schema: unknown): ProcedureBuilder;
    output(schema: unknown): ProcedureBuilder;
    query(handler: (...args: unknown[]) => unknown): unknown;
    mutation(handler: (...args: unknown[]) => unknown): unknown;
    subscription(handler: (...args: unknown[]) => unknown): unknown;
  }

  export interface InitTRPCBuilder {
    create(): {
      router: <T>(routes: T) => T;
      procedure: ProcedureBuilder;
    };
  }
  export const initTRPC: InitTRPCBuilder;

  // Bare-identifier router and createTRPCRouter shapes.
  export const router: <T>(routes: T) => T;
  export const createTRPCRouter: <T>(routes: T) => T;
  // Convenience alias so fixtures can write `import { publicProcedure }`.
  export const publicProcedure: ProcedureBuilder;
}
