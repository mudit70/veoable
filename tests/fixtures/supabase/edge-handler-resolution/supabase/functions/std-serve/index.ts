// std/http import — `serve(handler)` form (most common pattern in
// Supabase Edge Functions, including Neurotype's apple-server-notifications).
declare const serve: (handler: (req: Request) => Response | Promise<Response>) => void;

serve(async (req) => {
  return new Response(JSON.stringify({ method: req.method }), {
    headers: { 'content-type': 'application/json' },
  });
});
