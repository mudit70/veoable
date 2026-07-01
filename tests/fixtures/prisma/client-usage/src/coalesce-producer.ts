// #371 producer side — defines a `??`-coalesced singleton via a
// free-function factory. Mirrors formbricks's
// `packages/database/src/client.ts` exactly.
import { PrismaClient } from './prisma-client.js';

const prismaClientSingleton = (): PrismaClient => {
  return new PrismaClient();
};

declare const globalForPrisma: { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? prismaClientSingleton();
