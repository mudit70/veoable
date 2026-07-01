// #368 — Canonical "hot-reload guard" singleton pattern used by
// typebot.io and similar Next.js + Prisma stacks. The receiver
// `global.prisma` has no traceable initializer through ordinary
// symbol resolution; the value lives at a SEPARATE assignment
// expression in the same module. The resolver must scan the
// enclosing file for `global.<X> = <rhs>` / `globalThis.<X> = <rhs>`
// assignments and merge their classifications.
import { PrismaClient } from './prisma-client.js';

// Top-level conditional assignment to a global property — the
// formbricks/typebot pattern. NOTE: the actual `declare global`
// is replaced with a simple namespace shim so the fixture
// type-checks without polluting tests with @types ambient decls.
declare const global: { prisma?: PrismaClient };

if (!global.prisma) {
  global.prisma = new PrismaClient();
}

// The default export — what the consumer imports via
// `import prisma from "@typebot.io/prisma"`.
export default global.prisma;

// Local consumer using the same pattern to keep the test
// self-contained (no separate consumer file needed).
export async function listUsersViaGlobal() {
  // `global.prisma` here is the same chain the consumer walks:
  // the receiver is `global.prisma`, the resolver scans for
  // `global.prisma = ...` assignments above.
  return global.prisma.user.findMany();
}

// `globalThis` variant — same shape, different receiver name.
declare const globalThis: { db?: PrismaClient };

if (!globalThis.db) {
  globalThis.db = new PrismaClient();
}

export async function listUsersViaGlobalThis() {
  return globalThis.db.user.findMany();
}
