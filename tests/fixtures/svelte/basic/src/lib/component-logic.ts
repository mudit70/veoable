// Svelte component logic extracted into a .ts file.
// This simulates what you'd see in a Svelte component's <script> block.

import { onMount, onDestroy, writable } from './svelte-stubs.js';

const userStore = writable<string[]>([]);

export function setupUsers() {
  onMount(() => {
    fetch('/api/users')
      .then((res) => res.json())
      .then((data) => userStore.set(data));
  });

  onDestroy(() => {
    // cleanup
  });

  userStore.subscribe((users) => {
    console.log('Users updated:', users);
  });
}
