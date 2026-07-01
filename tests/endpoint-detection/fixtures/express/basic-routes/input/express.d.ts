// Ambient declaration of the `express` module so the fixture imports
// `from 'express'` exactly the way real Express code does. The
// framework-express visitor (after #180) traces receivers via
// ts-morph and verifies the originating factory was imported from a
// module specifier of `express`.
declare module 'express' {
  export interface Req {
    params: Record<string, string>;
    query: Record<string, string>;
    body: unknown;
  }
  export interface Res {
    json(body: unknown): void;
    status(code: number): Res;
    send(body?: unknown): void;
  }
  export type Handler = (req: Req, res: Res, next?: () => void) => void | Promise<void>;
  export interface Routable {
    get(path: string, ...handlers: Handler[]): Routable;
    post(path: string, ...handlers: Handler[]): Routable;
    put(path: string, ...handlers: Handler[]): Routable;
    delete(path: string, ...handlers: Handler[]): Routable;
    patch(path: string, ...handlers: Handler[]): Routable;
    head(path: string, ...handlers: Handler[]): Routable;
    options(path: string, ...handlers: Handler[]): Routable;
    all(path: string, ...handlers: Handler[]): Routable;
    use(...args: unknown[]): Routable;
    route(path: string): Routable;
  }
  export interface Application extends Routable {}
  interface ExpressFactory {
    (): Application;
    Router(): Routable;
  }
  const express: ExpressFactory;
  export default express;
  export function Router(): Routable;
}
