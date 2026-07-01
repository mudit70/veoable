// #110 — @fastify/websocket fixture.
import Fastify from 'fastify';

const fastify = Fastify();

// Canonical websocket route: { websocket: true } in options.
fastify.get('/ws', { websocket: true }, (connection: any, _req: any) => {
  connection.socket.on('message', (msg: Buffer) => {
    connection.socket.send(`echo: ${msg.toString()}`);
  });
});

// Non-websocket: regular HTTP GET — must remain GET, not WS.
fastify.get('/api/health', () => ({ ok: true }));

// Options object without `websocket` key — must remain GET.
fastify.get('/api/users', { schema: {} }, () => []);
