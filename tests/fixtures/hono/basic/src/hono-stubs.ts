// Minimal shape stubs for Hono.

export interface HonoContext {
  req: { param: (name: string) => string; query: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
  text: (body: string, status?: number) => Response;
  body: (body: unknown) => Response;
}

export type Handler = (c: HonoContext) => Response | Promise<Response>;

interface HonoApp {
  get: (path: string, ...handlers: Handler[]) => HonoApp;
  post: (path: string, ...handlers: Handler[]) => HonoApp;
  put: (path: string, ...handlers: Handler[]) => HonoApp;
  delete: (path: string, ...handlers: Handler[]) => HonoApp;
  patch: (path: string, ...handlers: Handler[]) => HonoApp;
  head: (path: string, ...handlers: Handler[]) => HonoApp;
  options: (path: string, ...handlers: Handler[]) => HonoApp;
  all: (path: string, ...handlers: Handler[]) => HonoApp;
  use: (...args: unknown[]) => HonoApp;
}

export function Hono(): HonoApp {
  const a: HonoApp = {
    get: () => a,
    post: () => a,
    put: () => a,
    delete: () => a,
    patch: () => a,
    head: () => a,
    options: () => a,
    all: () => a,
    use: () => a,
  };
  return a;
}
