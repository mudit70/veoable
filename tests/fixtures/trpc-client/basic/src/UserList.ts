import { trpc } from './trpc';
import { vanillaClient } from './vanilla';

export function UserList() {
  // Shape 1: React Query hook — `trpc.users.list.useQuery()`.
  const list = trpc.users.list.useQuery();

  // Shape 2: mutation — `trpc.users.create.useMutation()`.
  const create = trpc.users.create.useMutation();

  // Shape 3: nested path — `trpc.admin.users.byId.useQuery({id})`.
  const byId = trpc.admin.users.byId.useQuery({ id: '1' });

  return { list, create, byId };
}

export async function imperativeCalls() {
  // Shape 4: vanilla query — `client.users.get.query(input)`.
  const u = await vanillaClient.users.get.query({ id: '1' });

  // Shape 5: vanilla mutate — `client.users.create.mutate(input)`.
  const created = await vanillaClient.users.create.mutate({ name: 'Alice' });

  return { u, created };
}
