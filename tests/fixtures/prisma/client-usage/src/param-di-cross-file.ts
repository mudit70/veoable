// #307 — Cross-file ExtendedPrismaClient parameter type.
// Mirrors test-code-comprehension's actual layout: the type alias
// lives in a different module from the consumer, and the receiver
// is a function parameter.
import type { ExtendedPrismaClient } from './extend-prisma-client.js';

export default function initializeHandler(prisma: ExtendedPrismaClient) {
  return {
    async list() {
      return prisma.user.findMany();
    },
    async create(email: string) {
      return prisma.user.create({ data: { email } });
    },
  };
}
