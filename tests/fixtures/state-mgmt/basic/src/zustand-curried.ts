// #192 follow-up — curried + renamed-import + middleware-wrapped
// Zustand stores. Each form should still emit a StateStore node and
// have working READS_STATE / WRITES_STATE resolution.

import { create as makeStore } from 'zustand';

interface ToggleState {
  open: boolean;
  setOpen: (v: boolean) => void;
}

// Renamed import: `create` aliased to `makeStore`. Same direct shape
// as `useCounterStore` but with the alias.
export const useToggleStore = makeStore<ToggleState>((set, get) => ({
  open: false,
  setOpen: (v: boolean) => set({ open: v }),
}));

export function readToggleOpen(): boolean {
  return useToggleStore((s) => s.open);
}

export function flipToggle(): void {
  useToggleStore.getState().setOpen(true);
}

// Middleware-wrapped: `create(persist((set,get) => ({...})))`. The
// emit path unwraps one or more middleware layers to find the inner
// arrow.
declare function persist<T>(
  fn: (set: (s: Partial<T>) => void, get: () => T) => T,
): (set: (s: Partial<T>) => void, get: () => T) => T;

interface ProfileState {
  name: string;
  setName: (n: string) => void;
}

export const useProfileStore = makeStore<ProfileState>(
  persist<ProfileState>((set, get) => ({
    name: '',
    setName: (n: string) => set({ name: n }),
  })),
);

export function readProfileName(): string {
  return useProfileStore((s) => s.name);
}

export function setProfile(n: string): void {
  useProfileStore.getState().setName(n);
}
