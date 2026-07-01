// Minimal shape stubs so ts-morph can parse the fixtures without the
// real @hapi/hapi package.

export interface HapiRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  payload: unknown;
}

export interface HapiToolkit {
  response: (body?: unknown) => { code: (n: number) => unknown };
}

export type HapiHandler = (request: HapiRequest, h: HapiToolkit) => unknown;

interface RouteConfig {
  method: string | string[];
  path: string;
  handler: HapiHandler;
  options?: {
    validate?: Record<string, unknown>;
    auth?: string | false;
    tags?: string[];
  };
}

interface HapiServer {
  route: (config: RouteConfig | RouteConfig[]) => void;
  start: () => Promise<void>;
}

export function Hapi(): { server: (opts: { port: number }) => HapiServer } {
  return {
    server: () => ({
      route: () => {},
      start: async () => {},
    }),
  };
}

export function createServer(): HapiServer {
  return {
    route: () => {},
    start: async () => {},
  };
}
