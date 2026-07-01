import { defineStore } from 'pinia';

export const useUserStore = defineStore('users', {
  state: () => ({
    users: [] as any[],
    loading: false,
  }),
  actions: {
    async fetchUsers() {
      this.loading = true;
      const res = await fetch('/api/users');
      this.users = await res.json();
      this.loading = false;
    },
    async deleteUser(id: string) {
      await fetch(`/api/users/${id}`, { method: 'DELETE' });
      this.users = this.users.filter(u => u.id !== id);
    },
  },
});
