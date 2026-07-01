import { prisma } from '../lib/prisma.js';

/**
 * Service layer that the Express handlers delegate to. Exercises the
 * cross-file call graph: the handler in server.ts calls into this
 * file, which calls prisma.user.*, and the flow walker should trace
 * through the whole chain.
 */

export async function listUsers() {
  return prisma.user.findMany();
}

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}
