import { create } from 'zustand';

interface UserStore {
  users: any[];
  loading: boolean;
  fetchUsers: () => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
}

export const useUserStore = create<UserStore>((set, get) => ({
  users: [],
  loading: false,
  fetchUsers: async () => {
    set({ loading: true });
    const res = await fetch('/api/users');
    const users = await res.json();
    set({ users, loading: false });
  },
  deleteUser: async (id) => {
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    set({ users: get().users.filter(u => u.id !== id) });
  },
}));
