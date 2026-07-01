// Minimal stubs for Remix types.

export interface LoaderFunctionArgs {
  request: Request;
  params: Record<string, string>;
}

export interface ActionFunctionArgs {
  request: Request;
  params: Record<string, string>;
}

export function json<T>(data: T, init?: number | ResponseInit): Response {
  return new Response(JSON.stringify(data), typeof init === 'number' ? { status: init } : init);
}

export function redirect(url: string, init?: number | ResponseInit): Response {
  return new Response(null, {
    status: typeof init === 'number' ? init : 302,
    headers: { Location: url },
  });
}
