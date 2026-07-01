// SvelteKit client-side load function.
// Route: /

import type { LoadEvent } from '../lib/sveltekit-stubs.js';

export async function load({ fetch }: LoadEvent) {
  const res = await fetch('/api/data');
  return { data: await res.json() };
}
