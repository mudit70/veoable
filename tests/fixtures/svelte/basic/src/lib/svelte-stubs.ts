// Minimal stubs for Svelte lifecycle functions.

export function onMount(fn: () => void | (() => void)): void {}
export function onDestroy(fn: () => void): void {}
export function beforeUpdate(fn: () => void): void {}
export function afterUpdate(fn: () => void): void {}

// Svelte store stubs
export interface Readable<T> {
  subscribe(run: (value: T) => void): { unsubscribe: () => void };
}

export interface Writable<T> extends Readable<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

export function writable<T>(value: T): Writable<T> {
  return {
    subscribe: (_run) => ({ unsubscribe: () => {} }),
    set: () => {},
    update: () => {},
  };
}
