import useSWR, { preload } from 'swr';
import useSWRMutation from 'swr/mutation';
import useSWRSubscription from 'swr/subscription';
import { fetchOrders, fetchOrder } from './api';

export function OrdersList() {
  // Shape 1: bare identifier fetcher.
  const all = useSWR('/api/orders', fetchOrders);

  // Shape 2: inline arrow fetcher.
  const one = useSWR('/api/orders/1', async (key: string) => fetchOrder(key));

  // Shape 3: SWRMutation with bare fetcher.
  const mut = useSWRMutation('/api/orders', fetchOrders);

  // Shape 4: useSWRSubscription — the `subscribe` setup function
  // isn't a fetcher per se, but is still the user-code function the
  // runtime invokes. Resolves the same way as a fetcher.
  const sub = useSWRSubscription('/api/orders', subscribe);

  // Shape 5: imperative `preload(key, fetcher)`. The call must also
  // emit a process + TRIGGERS edge so flow walks of code that
  // pre-warms the cache reach the fetcher.
  preload('/api/orders', fetchOrders);

  return { all, one, mut, sub };
}

function subscribe(_key: string, _ctx: { next: (err: unknown, data: unknown) => void }) {
  return () => { /* unsubscribe */ };
}

// Module-scope preload — currently dropped because lang-ts emits no
// FunctionDefinition for module-level code to anchor the
// ClientSideProcess.functionId. The lock-in test asserts this stays
// dropped until a separate lang-ts change emits a module FD.
preload('/api/orders', fetchOrders);
