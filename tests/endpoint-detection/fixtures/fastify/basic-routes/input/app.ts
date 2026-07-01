const fastify = { get: () => {}, post: () => {}, put: () => {}, delete: () => {} };
fastify.get('/users', async () => []);
fastify.post('/users', async () => ({}));
fastify.put('/users/:id', async () => ({}));
fastify.delete('/users/:id', async () => {});
