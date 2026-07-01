import { PrismaClient } from '../stubs/prisma-client.js';

/**
 * Shared Prisma Client instance used by the service layer. The
 * canonical-name `prisma` is the receiver heuristic the framework-
 * prisma visitor matches against.
 */
export const prisma = new PrismaClient();
