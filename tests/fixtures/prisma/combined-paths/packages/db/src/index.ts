// Stub of `@prisma/client` mirroring the shape the visitor needs.
// The visitor dispatches on receiver name and chain shape, not the
// type system, but providing a real export makes the fixture
// compile and lets ts-morph resolve the cross-package import.
export class PrismaClient {
  user = {
    findMany: async (_args?: unknown) => [] as Array<{ id: number }>,
    findUnique: async (_args: unknown) => null as { id: number } | null,
    create: async (_args: unknown) => ({ id: 1 }),
    update: async (_args: unknown) => ({ id: 1 }),
  };
  post = {
    findMany: async (_args?: unknown) => [] as Array<{ id: number }>,
    create: async (_args: unknown) => ({ id: 1 }),
  };
}

// PrismaService extends PrismaClient — the canonical NestJS pattern.
// Consumer services declare this as a constructor parameter property
// (#326). Living in this package, the consumer reaches it via the
// cross-package import (#334).
export class PrismaService extends PrismaClient {}

// Documenso-style memoize wrapper (#317). Lives in the same package
// so the consumer's HOF call site is `remember(() => new PrismaClient())`
// using this exported wrapper symbol.
export function remember<T>(_key: string, factory: () => T): T {
  return factory();
}
