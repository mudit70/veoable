// Minimal Fastify stubs for testing (no real fastify dependency needed).

export interface FastifyRequest {
  params: Record<string, string>;
  body: unknown;
  user?: { userId: string };
  jwtVerify(): Promise<void>;
}

export interface FastifyReply {
  status(code: number): FastifyReply;
  send(data?: unknown): FastifyReply;
  json(data: unknown): void;
  redirect(url: string): void;
}

export interface FastifyInstance {
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): void;
  get(path: string, opts: Record<string, unknown>, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): void;
  post(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): void;
  put(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): void;
  delete(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): void;
  register(plugin: unknown, opts?: { prefix?: string }): Promise<void>;
  addHook(name: string, handler: unknown): void;
}

export function Fastify(): FastifyInstance {
  return {} as FastifyInstance;
}
