import { onMount, onDestroy } from 'svelte';
import { users, fetchUsers } from '../stores/user-store';

export function setupUserList() {
  onMount(() => {
    fetchUsers();
  });

  onDestroy(() => {
    // cleanup subscriptions
  });

  users.subscribe(value => {
    console.log('Users updated:', value.length);
  });
}
