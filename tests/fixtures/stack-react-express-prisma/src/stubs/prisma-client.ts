// Minimal PrismaClient stub. The visitor dispatches on the AST
// shape `new PrismaClient()` (the constructor identifier), so this
// only needs to compile.
export class PrismaClient {
  user = {
    findMany: async (_args?: unknown) => [] as Array<{ id: number; email: string; name: string | null }>,
    findUnique: async (_args: unknown) =>
      null as { id: number; email: string; name: string | null } | null,
    create: async (_args: unknown) => ({ id: 1, email: '', name: null }),
    update: async (_args: unknown) => ({ id: 1, email: '', name: null }),
    delete: async (_args: unknown) => ({ id: 1, email: '', name: null }),
  };
  post = {
    findMany: async (_args?: unknown) => [] as Array<{ id: number; title: string; userId: number | null }>,
    create: async (_args: unknown) => ({ id: 1, title: '', userId: null }),
  };
}
