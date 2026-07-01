declare module '@trpc/server' {
  export interface ProcedureBuilder {
    input(schema: unknown): ProcedureBuilder;
    output(schema: unknown): ProcedureBuilder;
    query(handler: (...args: unknown[]) => unknown): unknown;
    mutation(handler: (...args: unknown[]) => unknown): unknown;
    subscription(handler: (...args: unknown[]) => unknown): unknown;
  }
  export const router: <T>(routes: T) => T;
  export const publicProcedure: ProcedureBuilder;
}
