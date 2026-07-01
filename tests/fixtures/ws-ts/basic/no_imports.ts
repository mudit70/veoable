// File without ws/socket.io imports — must produce zero emits.

class FakeServer {
  on(_evt: string, _h: (s: unknown) => void) {}
}

export function setup() {
  const wss = new FakeServer();
  wss.on('connection', () => {});
}
