// Pathological: two serve(...) calls in one Edge Function file. The
// first is the prod handler; the second is a dev-mode override (or
// vice versa). Without dedup, both would emit APIEndpoints with the
// same id (lineStart=1) and the second would silently overwrite the
// first. The visitor dedupes by id so the FIRST serve(...) wins.
declare const serve: (handler: (req: Request) => Response | Promise<Response>) => void;

if (Math.random() > 0.5) {
  serve((req) => new Response('first'));
} else {
  serve((req) => new Response('second'));
}
