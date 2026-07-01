import type { FastifyRequest, FastifyReply } from './stubs.js';

// Simulated prisma for the test
const prisma = { user: { findMany: async () => [], findUnique: async (_: unknown) => null, create: async (_: unknown) => ({}) } };

export async function listUsersHandler(_req: FastifyRequest, reply: FastifyReply) {
  const users = await prisma.user.findMany();
  reply.send(users);
}

export async function getUserHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    return reply.status(404).send({ error: 'User not found' });
  }
  reply.send(user);
}

export async function createUserHandler(req: FastifyRequest, reply: FastifyReply) {
  const user = await prisma.user.create({ data: req.body });
  reply.status(201).send(user);
}
