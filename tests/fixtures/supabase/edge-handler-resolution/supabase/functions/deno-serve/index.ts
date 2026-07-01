// `Deno.serve(handler)` form — Deno runtime builtin.
declare const Deno: {
  serve: (...args: any[]) => void;
};

Deno.serve((req: Request) => {
  return new Response('hello from deno-serve');
});
