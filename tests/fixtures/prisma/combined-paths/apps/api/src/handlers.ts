// #349 — combined-paths fixture. Exercises all three resolver paths
// in a single analysis run:
//
//   1. Cross-package activation (#334): this file's package
//      (`apps/api/`) has no local Prisma schema. The schema lives
//      in a sibling package (`packages/db/`). PrismaPlugin should
//      activate via `ctx.workspaceRoot` / `ctx.prismaSchemas`.
//   2. NestJS DI receiver (#326): the constructor-injected
//      `PrismaService` field, type-annotated with a class that
//      extends PrismaClient imported from the sibling package, must
//      resolve to `client` via the type-annotation fallback.
//   3. HOF wrapper (#317): the `remember(...)` call wraps a factory
//      returning `new PrismaClient()` and produces a singleton; the
//      resolver follows into the wrapper's last argument.
import { PrismaClient, PrismaService, remember } from '@combined/db';

// (1) + (2) — DI path against a cross-package PrismaService.
export class UserController {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.user.findMany();
  }

  async create(email: string) {
    return this.prisma.user.create({ data: { email } });
  }
}

// (1) + (3) — HOF wrapper path against a cross-package `remember`.
const cachedPrisma = remember('prisma', () => new PrismaClient());

export async function listAll() {
  return cachedPrisma.user.findMany();
}

export async function createPost(title: string) {
  return cachedPrisma.post.create({ data: { title, authorId: 1 } });
}
