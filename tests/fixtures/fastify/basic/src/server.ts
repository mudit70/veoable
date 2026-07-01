import { Fastify, type FastifyRequest, type FastifyReply } from './stubs.js';
import { listUsersHandler, getUserHandler, createUserHandler } from './handlers.js';

const fastify = Fastify();

// Direct handler reference
fastify.get('/api/users', listUsersHandler);

// Direct handler reference with param
fastify.get('/api/users/:id', getUserHandler);

// Direct handler reference
fastify.post('/api/users', createUserHandler);

// Inline handler
fastify.delete('/api/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  reply.status(204).send();
});

// Options object with handler key
fastify.put('/api/users/:id', {
  handler: async (req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ updated: true });
  },
});
