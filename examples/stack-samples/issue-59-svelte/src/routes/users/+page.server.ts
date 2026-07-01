import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  return { users: [{ id: 1, name: 'Alice' }] };
};

export const actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    return { success: true };
  },
  delete: async ({ request }) => {
    return { deleted: true };
  },
} satisfies Actions;
