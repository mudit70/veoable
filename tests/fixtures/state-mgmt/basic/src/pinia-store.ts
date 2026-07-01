import { defineStore } from 'pinia';

// Pinia: defineStore — should be detected as state_observer
export const useUserStore = defineStore('users', {
  state: () => ({
    users: [] as string[],
  }),
  actions: {
    async fetchUsers() {
      const res = await fetch('/api/users');
      // this.users = await res.json();
    },
    async deleteUser(_id: string) {
      await fetch('/api/users/' + _id, { method: 'DELETE' });
    },
  },
});
