// #110 — @fastify/jwt + preHandler middleware-chain fixture.
import Fastify from 'fastify';

const fastify = Fastify();

declare const otherCheck: (req: any, res: any) => Promise<void>;

// Single preHandler — most common @fastify/jwt usage.
fastify.get('/protected', { preHandler: fastify.authenticate }, async (req: any) => {
  return { user: (req as any).user };
});

// Array of preHandlers.
fastify.get('/admin', { preHandler: [fastify.authenticate, otherCheck] }, async () => {
  return { ok: true };
});

// onRequest hook chain (an alternative to preHandler).
fastify.post('/upload', {
  onRequest: [fastify.authenticate],
  preValidation: otherCheck,
}, async () => ({ uploaded: true }));

// Bare route — no middleware chain.
fastify.get('/public', async () => ({ public: true }));
