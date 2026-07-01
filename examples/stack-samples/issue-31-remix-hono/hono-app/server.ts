import { Hono } from 'hono';

const app = new Hono();

function listUsers(c: any) { return c.json([]); }

app.get('/api/users', listUsers);
app.get('/api/users/:id', (c) => c.json({ id: c.req.param('id') }));
app.post('/api/users', (c) => c.json({ created: true }, 201));
app.put('/api/users/:id', (c) => c.json({ updated: true }));
app.delete('/api/users/:id', (c) => c.text('', 204));
