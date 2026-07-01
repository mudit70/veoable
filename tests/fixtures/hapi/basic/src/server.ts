import { createServer, type HapiRequest, type HapiToolkit, type HapiHandler } from './hapi-stubs.js';

const server = createServer();

// Same-file named handler — should resolve to a FunctionDefinition.
function listUsers(_request: HapiRequest, h: HapiToolkit) {
  return h.response([]);
}

// Same-file variable-bound arrow handler.
const getUserById = (request: HapiRequest, h: HapiToolkit) => {
  return h.response({ id: request.params.id });
};

// Single route object with named handler.
server.route({
  method: 'GET',
  path: '/users',
  handler: listUsers,
});

// Single route object with variable-bound handler.
server.route({
  method: 'GET',
  path: '/users/{userId}',
  handler: getUserById,
});

// Inline handler.
server.route({
  method: 'POST',
  path: '/users',
  handler: (request, h) => {
    return h.response({ created: true }).code(201);
  },
});

// All standard verbs.
server.route({
  method: 'PUT',
  path: '/users/{userId}',
  handler: (_request, h) => h.response({ updated: true }),
});

server.route({
  method: 'DELETE',
  path: '/users/{userId}',
  handler: (_request, h) => h.response().code(204),
});

server.route({
  method: 'PATCH',
  path: '/users/{userId}',
  handler: (_request, h) => h.response({ patched: true }),
});

// Array of route objects.
server.route([
  {
    method: 'GET',
    path: '/health',
    handler: (_request, h) => h.response({ status: 'ok' }),
  },
  {
    method: 'GET',
    path: '/version',
    handler: (_request, h) => h.response({ version: '1.0.0' }),
  },
]);

// Multi-method route (method is an array).
server.route({
  method: ['GET', 'POST'],
  path: '/multi',
  handler: (_request, h) => h.response('ok'),
});

// Hapi {param} syntax with optional parameter.
server.route({
  method: 'GET',
  path: '/items/{itemId}/reviews/{reviewId}',
  handler: (_request, h) => h.response({}),
});
