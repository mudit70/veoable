// Stub of @prisma/client so ts-morph can resolve the import. The
// visitor does NOT need this type to resolve correctly — it
// dispatches on name, not type — but having a valid import makes the
// fixture compile cleanly.
export class PrismaClient {
  user = {
    findMany: async (_args?: unknown) => [] as Array<{ id: number }>,
    findUnique: async (_args: unknown) => null as { id: number } | null,
    findFirst: async (_args?: unknown) => null as { id: number } | null,
    create: async (_args: unknown) => ({ id: 1 }),
    createMany: async (_args: unknown) => ({ count: 1 }),
    update: async (_args: unknown) => ({ id: 1 }),
    updateMany: async (_args: unknown) => ({ count: 1 }),
    upsert: async (_args: unknown) => ({ id: 1 }),
    delete: async (_args: unknown) => ({ id: 1 }),
    deleteMany: async (_args: unknown) => ({ count: 1 }),
    count: async (_args?: unknown) => 0,
    aggregate: async (_args?: unknown) => ({}),
  };
  post = {
    findMany: async (_args?: unknown) => [] as Array<{ id: number }>,
    create: async (_args: unknown) => ({ id: 1 }),
    delete: async (_args: unknown) => ({ id: 1 }),
  };
  $queryRaw = async (..._args: unknown[]) => [] as unknown[];
  $executeRaw = async (..._args: unknown[]) => 0;
  $queryRawUnsafe = async (..._args: unknown[]) => [] as unknown[];
  $executeRawUnsafe = async (..._args: unknown[]) => 0;
  $transaction = async <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> => fn(this);
  // #307 — Prisma's official extension API. Returns a wrapped
  // client whose model accessors mirror the base. The fixture
  // stub returns `this` for shape parity; the resolver only
  // cares about the syntactic `.$extends(...)` call site, not
  // about runtime identity.
  $extends(_ext: unknown): PrismaClient {
    return this;
  }
}
