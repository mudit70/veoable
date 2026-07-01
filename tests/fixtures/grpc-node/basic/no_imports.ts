// File without @grpc/grpc-js import — must produce zero emits even
// though it happens to have an addService method.

class FakeServer {
  addService(svc: unknown, handlers: Record<string, unknown>) {
    void svc;
    void handlers;
  }
}

declare const NotAService: unknown;

export function setup() {
  const s = new FakeServer();
  s.addService(NotAService, { SayHi: () => {} });
}
