import { create } from 'zustand';

interface UserStore {
  users: string[];
  fetchUsers: () => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
  clearFilter: () => void;
}

// Zustand: create — should be detected as state_observer
export const useUserStore = create<UserStore>((set, get) => ({
  users: [],
  fetchUsers: async () => {
    const res = await fetch('/api/users');
    const users = await res.json();
    set({ users });
  },
  deleteUser: async (id) => {
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    set({ users: get().users.filter((u) => u !== id) });
  },
  clearFilter: () => set({ users: [] }),
}));
