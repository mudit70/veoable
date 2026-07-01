// Supabase Edge Function: billing-webhook
Deno.serve(async (req: Request) => {
  const body = await req.json();
  return new Response(JSON.stringify({ received: body }));
});
