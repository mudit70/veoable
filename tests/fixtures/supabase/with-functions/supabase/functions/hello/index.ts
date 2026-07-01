// Supabase Edge Function: hello
// Canonical Deno.serve handler.
Deno.serve((req: Request) => {
  return new Response(JSON.stringify({ message: 'hello' }), {
    headers: { 'content-type': 'application/json' },
  });
});
