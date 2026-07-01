import { writable } from 'svelte/store';

export const users = writable<any[]>([]);

export async function fetchUsers() {
  const res = await fetch('/api/users');
  const data = await res.json();
  users.set(data);
}
