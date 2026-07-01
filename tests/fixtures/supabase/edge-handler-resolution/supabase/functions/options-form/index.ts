// `Deno.serve(options, handler)` form — handler is the second arg.
declare const Deno: {
  serve: (...args: any[]) => void;
};

Deno.serve({ port: 8000 }, async (req: Request) => {
  return new Response('options-form ok');
});
