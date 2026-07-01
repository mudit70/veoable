// #192 — Zustand read/write fixture. Same-file MVP.
import { create } from 'zustand';

interface CounterState {
  count: number;
  label: string;
  increment: () => void;
  setLabel: (l: string) => void;
}

// Single-file store binding.
export const useCounterStore = create<CounterState>((set, get) => ({
  count: 0,
  label: 'idle',
  increment: () => set({ count: get().count + 1 }),
  setLabel: (l: string) => set({ label: l }),
}));

// READS_STATE — selector form.
export function readCount(): number {
  return useCounterStore((s) => s.count);
}

// READS_STATE — broader selector returning an object literal. The
// edge still fires (with field=null) so the function is attached to
// the store.
export function readBoth() {
  return useCounterStore((s) => ({ count: s.count, label: s.label }));
}

// WRITES_STATE — getState().<action>() form.
export function bumpCounter(): void {
  useCounterStore.getState().increment();
}

// WRITES_STATE — different action on the same store.
export function nameIt(label: string): void {
  useCounterStore.getState().setLabel(label);
}

// Negative: a non-Zustand `.create` (e.g., `Model.create({...})` or
// `Stripe.customers.create({...})`) and a non-Zustand `.getState()`
// (e.g., a redux-style call). Neither should fire any state edges.
declare const Model: { create: (cfg: object) => unknown };
declare const reduxStoreLike: { getState: () => { foo: string } };

export function notAStore() {
  // Looks like create, but it's `Model.create({...})` with a non-arrow
  // first arg — must NOT emit StateStore or any state edges.
  Model.create({ name: 'x' });
}

export function notAGetState() {
  // Looks like getState, but the receiver isn't a zustand binding.
  return reduxStoreLike.getState().foo;
}

// In-store `set`/`get` parameter calls — must NOT emit READS_STATE /
// WRITES_STATE edges. The `set` and `get` here are the function
// parameters of the `create` config arrow, NOT the store binding.
// (The fixture above already exercises these inside `useCounterStore`'s
// definition; this guard is mainly here so future visitor changes
// don't regress.)
