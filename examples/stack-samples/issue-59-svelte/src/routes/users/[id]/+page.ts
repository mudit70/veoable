import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
  const res = await fetch(`/api/users/${params.id}`);
  return { user: await res.json() };
};
