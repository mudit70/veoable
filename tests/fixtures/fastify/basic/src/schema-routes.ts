// #110 — Fastify declarative response schemas. The visitor must
// emit `responses` on the APIEndpoint, one entry per status-code
// key under `schema.response`, complementing the AST-observed
// `reply.send()` shapes on the handler function.
import { Fastify, type FastifyRequest, type FastifyReply } from './stubs.js';
import { listUsersHandler } from './handlers.js';

const fastify = Fastify();

// 1. Simple numeric-key schema with success + 404 error path.
fastify.get('/api/users', {
  schema: {
    response: {
      200: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'number' } } },
      },
      404: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  handler: listUsersHandler,
});

// 2. Schema with wildcard buckets (`'2xx'`, `'4xx'`) plus a 200.
fastify.get('/api/orders', {
  schema: {
    response: {
      '2xx': { type: 'object' },
      '4xx': { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  handler: async (req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ orders: [] });
  },
});

// 3. (path, opts, handler) signature with response schema in opts.
fastify.post(
  '/api/things',
  {
    schema: {
      response: {
        201: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  },
  async (req: FastifyRequest, reply: FastifyReply) => {
    reply.status(201).send({ id: 'abc' });
  },
);

// 4. Route WITHOUT a response schema — endpoint should still
//    emit, but `responses` must be absent (not an empty array).
fastify.get('/api/no-schema', async (req: FastifyRequest, reply: FastifyReply) => {
  reply.send({ ok: true });
});

// 5. Route with `schema.body` but NO `schema.response` — same
//    contract as #4: no `responses` on the endpoint.
fastify.post(
  '/api/body-only',
  {
    schema: {
      body: { type: 'object', properties: { name: { type: 'string' } } },
    },
  },
  async (req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ created: true });
  },
);

// 6. Mixed numeric + wildcard + default keys in one response object.
//    Pins that all three kinds coexist in a single emission.
fastify.get('/api/mixed', {
  schema: {
    response: {
      200: { type: 'object' },
      '4xx': { type: 'object' },
      default: { type: 'object' },
    },
  },
  handler: listUsersHandler,
});

// 7. Long schema body — exercises the 240-char source-text
//    truncation so the test can assert the ellipsis sentinel.
fastify.get('/api/long-schema', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          padding: { type: 'string', description: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        },
      },
    },
  },
  handler: listUsersHandler,
});
