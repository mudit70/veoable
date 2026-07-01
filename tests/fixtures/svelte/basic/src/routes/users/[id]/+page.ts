// SvelteKit client-side load with dynamic param.
// Route: /users/:id

import type { LoadEvent } from '../../../lib/sveltekit-stubs.js';

export const load = async ({ params, fetch }: LoadEvent) => {
  const res = await fetch(`/api/users/${params.id}`);
  return { user: await res.json() };
};
