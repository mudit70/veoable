import { Hono, type HonoContext, type Handler } from './hono-stubs.js';

const app = Hono();

// Same-file named handler.
function listUsers(c: HonoContext) {
  return c.json([]);
}

// Same-file variable-bound arrow handler.
const getUserById = (c: HonoContext) => {
  return c.json({ id: c.req.param('id') });
};

// Routes with named handlers.
app.get('/users', listUsers);
app.get('/users/:id', getUserById);

// Route with an inline arrow handler.
app.post('/users', (c) => {
  return c.json({ created: true }, 201);
});

// Route with middleware.
const authMiddleware: Handler = async (c) => c.json({});
app.delete('/users/:id', authMiddleware, (c) => {
  return c.text('', 204);
});

// All Hono verbs.
app.put('/users/:id', (c) => c.json({}));
app.patch('/users/:id', (c) => c.json({}));
app.head('/users/:id', (c) => c.text(''));
app.options('/users/:id', (c) => c.text(''));
app.all('/catch-all', (c) => c.text('ok'));
