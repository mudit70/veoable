// #371 — Canonical Next.js + Prisma "globalThis hot-reload guard"
// singleton, in the cross-file variant used by formbricks / rallly /
// many Next-on-Prisma monorepos:
//
//   const prismaClientSingleton = () => new PrismaClient({...});
//   declare const globalForPrisma: { prisma?: PrismaClient };
//   export const prisma = globalForPrisma.prisma ?? prismaClientSingleton();
//
// Each individual piece is supported:
//   - `??` BinaryExpression → mergeKinds of both arms (#312)
//   - free-function-call factory `prismaClientSingleton()` → walk into
//     the function body for `new PrismaClient(...)` (#323 / #325)
//   - cross-file imported binding → follow to the source-file export
//
// Combined cross-file the chain has to thread through all three.
import { PrismaClient } from './prisma-client.js';

// Producer-side factory (analog of formbricks's `prismaClientSingleton`).
const buildClient = (): PrismaClient => {
  return new PrismaClient();
};

// `globalForPrisma.prisma ?? buildClient()` — the canonical chain.
declare const globalForPrisma: { prisma?: PrismaClient };
export const coalescedPrisma: PrismaClient = globalForPrisma.prisma ?? buildClient();

export async function listUsersViaCoalesce() {
  return coalescedPrisma.user.findMany();
}
