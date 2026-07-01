import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'socket.io';

export function startWsServer() {
  const wss = new WebSocketServer({ port: 8080, path: '/api/chat' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      void data;
    });
  });
  return wss;
}

export function startWsWithoutPath() {
  return new WebSocketServer({ port: 8081 });
}

export function startSocketIO(httpServer: unknown) {
  const io = new Server(httpServer as never);
  io.on('connection', (socket) => {
    socket.on('chat:message', () => {});
  });
  return io;
}

export function connectClient() {
  return new WebSocket('ws://api.example.com/feed');
}
