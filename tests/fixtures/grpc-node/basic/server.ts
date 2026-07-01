import { Server, ServerCredentials } from '@grpc/grpc-js';

declare const GreeterService: unknown;
declare const OrdersService: unknown;

function sayHello(call: unknown, cb: unknown) {
  void call;
  void cb;
}

function sayGoodbye(call: unknown, cb: unknown) {
  void call;
  void cb;
}

export function startServer() {
  const server = new Server();
  server.addService(GreeterService, {
    SayHello: sayHello,
    SayGoodbye: sayGoodbye,
  });
  server.addService(OrdersService, {
    CreateOrder: (call: unknown, cb: unknown) => {
      void call;
      void cb;
    },
    GetOrder: function (call: unknown, cb: unknown) {
      void call;
      void cb;
    },
    DeleteOrder: handler,
  });
  server.bindAsync('0.0.0.0:50051', ServerCredentials.createInsecure(), () => {});
}

function handler(call: unknown, cb: unknown) {
  void call;
  void cb;
}
