// Mirror of test-code-comprehension's `extendPrismaClient.ts`:
// the actual factory wraps the client with `$extends(...)`; the
// public type alias is `ReturnType<typeof ...>`.
import { PrismaClient } from './prisma-client.js';

export type ExtendedPrismaClient = ReturnType<typeof extendPrismaClient>;

function extendPrismaClient() {
  const prisma = new PrismaClient();
  return prisma.$extends({ name: 'logging' });
}
