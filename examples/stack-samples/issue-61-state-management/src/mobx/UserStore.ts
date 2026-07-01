import { makeAutoObservable, autorun, reaction } from 'mobx';

class UserStore {
  users: any[] = [];
  loading = false;

  constructor() {
    makeAutoObservable(this);

    autorun(() => {
      console.log('User count:', this.users.length);
    });

    reaction(
      () => this.loading,
      (loading) => console.log('Loading state:', loading)
    );
  }

  async fetchUsers() {
    this.loading = true;
    const res = await fetch('/api/users');
    this.users = await res.json();
    this.loading = false;
  }

  async deleteUser(id: string) {
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    this.users = this.users.filter(u => u.id !== id);
  }
}

export const userStore = new UserStore();
