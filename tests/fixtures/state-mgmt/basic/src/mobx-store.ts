import { makeAutoObservable, autorun, reaction } from 'mobx';

class UserStore {
  users: string[] = [];

  constructor() {
    makeAutoObservable(this);

    // MobX: autorun — should be detected as state_observer
    autorun(() => {
      console.log('Users changed:', this.users.length);
    });

    // MobX: reaction — should be detected as state_observer
    reaction(
      () => this.users.length,
      (length) => console.log('User count:', length)
    );
  }

  async fetchUsers() {
    const res = await fetch('/api/users');
    this.users = await res.json();
  }
}

export const userStore = new UserStore();
