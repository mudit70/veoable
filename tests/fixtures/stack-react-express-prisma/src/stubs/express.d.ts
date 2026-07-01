// Ambient declaration of the `express` module so the fixture imports
// `from 'express'` exactly the way real Express code does.
declare module 'express' {
  export interface Req {
    params: Record<string, string>;
    query: Record<string, string>;
    body: unknown;
  }
  export interface Res {
    json(body: unknown): Res;
    status(code: number): Res;
    send(body?: unknown): void;
  }
  export type Handler = (req: Req, res: Res, next?: () => void) => void | Promise<void>;
  export interface Routable {
    get(path: string, ...handlers: Handler[]): Routable;
    post(path: string, ...handlers: Handler[]): Routable;
    put(path: string, ...handlers: Handler[]): Routable;
    delete(path: string, ...handlers: Handler[]): Routable;
    use(...args: unknown[]): Routable;
    listen(port: number, cb?: () => void): void;
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
