// Minimal shape stubs so ts-morph can parse the fixtures without the
// real koa / koa-router packages. The visitor dispatches on AST text
// (receiver name, method name, arguments) rather than types.

export interface KoaContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  status: number;
}

export type Middleware = (ctx: KoaContext, next: () => Promise<void>) => void | Promise<void>;

interface KoaRouter {
  get: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  post: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  put: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  delete: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  patch: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  head: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  options: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  all: (pathOrName: string, ...handlers: (string | Middleware)[]) => KoaRouter;
  routes: () => Middleware;
  allowedMethods: () => Middleware;
}

export function Router(_opts?: { prefix?: string }): KoaRouter {
  const r: KoaRouter = {
    get: () => r,
    post: () => r,
    put: () => r,
    delete: () => r,
    patch: () => r,
    head: () => r,
    options: () => r,
    all: () => r,
    routes: () => (() => {}) as Middleware,
    allowedMethods: () => (() => {}) as Middleware,
  };
  return r;
}

interface KoaApp {
  use: (middleware: Middleware) => KoaApp;
  listen: (port: number) => void;
}

export function Koa(): KoaApp {
  return {
    use: function() { return this; },
    listen: () => {},
  };
}
