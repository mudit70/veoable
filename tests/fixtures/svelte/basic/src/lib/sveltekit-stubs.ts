// Minimal stubs for SvelteKit types.

export interface LoadEvent {
  params: Record<string, string>;
  url: URL;
  fetch: typeof fetch;
}

export interface ServerLoadEvent extends LoadEvent {
  locals: Record<string, unknown>;
}

export interface RequestEvent {
  params: Record<string, string>;
  request: Request;
  url: URL;
  locals: Record<string, unknown>;
}

export function json<T>(data: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), init);
}

export function redirect(status: number, location: string): never {
  throw new Error(`Redirect ${status} ${location}`);
}

export function fail(status: number, data?: Record<string, unknown>) {
  return { status, data };
}
