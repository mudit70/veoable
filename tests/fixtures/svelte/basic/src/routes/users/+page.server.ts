// SvelteKit server-side load + form actions.
// Route: /users

import { json, fail, type ServerLoadEvent, type RequestEvent } from '../../lib/sveltekit-stubs.js';

export async function load({ locals }: ServerLoadEvent) {
  return { users: ['Alice', 'Bob'] };
}

export const actions = {
  default: async ({ request }: RequestEvent) => {
    const data = await request.formData();
    const name = data.get('name');
    if (!name) return fail(400, { error: 'Name required' });
    return { success: true };
  },
  delete: async ({ request }: RequestEvent) => {
    return { deleted: true };
  },
};
