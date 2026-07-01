import Hapi from '@hapi/hapi';

const server = Hapi.server({ port: 3000 });

function listUsers(request: Hapi.Request, h: Hapi.ResponseToolkit) {
  return h.response([{ id: 1, name: 'Alice' }]);
}

server.route({
  method: 'GET',
  path: '/api/users',
  handler: listUsers,
});

server.route({
  method: 'GET',
  path: '/api/users/{userId}',
  handler: (request, h) => h.response({ id: request.params.userId }),
});

server.route([
  { method: 'POST', path: '/api/users', handler: (request, h) => h.response({ created: true }).code(201) },
  { method: 'DELETE', path: '/api/users/{userId}', handler: (request, h) => h.response().code(204) },
]);

server.route({
  method: ['GET', 'POST'],
  path: '/api/health',
  handler: (request, h) => h.response({ status: 'ok' }),
});
