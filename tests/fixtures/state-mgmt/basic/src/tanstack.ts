// Fixture for #256 Phase C — TanStack Query / RTK Query indirection.
import { useQuery, useMutation, useInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query';

// Named query function — resolvable to FunctionDefinition.id.
async function fetchUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

// Variable-bound mutation function.
const createUser = async (data: { name: string }) => {
  const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  return res.json();
};

// Component using object-form useQuery with named queryFn.
export function UsersList() {
  const { data } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  return data;
}

// Component using inline-arrow queryFn (Pattern 4 names it 'queryFn').
export function PostsList() {
  const { data } = useQuery({
    queryKey: ['posts'],
    queryFn: async () => {
      const res = await fetch('/api/posts');
      return res.json();
    },
  });
  return data;
}

// Component using legacy positional-arg form.
export function LegacyList() {
  const { data } = useQuery(['legacy'], fetchUsers);
  return data;
}

// Component using useMutation with named mutationFn.
export function CreateUserForm() {
  const { mutate } = useMutation({ mutationFn: createUser });
  return mutate;
}

// Component using useMutation with inline arrow.
export function DeleteUserForm() {
  const { mutate } = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/users/${id}`, { method: 'DELETE' });
    },
  });
  return mutate;
}

// useInfiniteQuery with named fn.
export function FeedList() {
  const { data } = useInfiniteQuery({ queryKey: ['feed'], queryFn: fetchUsers });
  return data;
}

// useSuspenseQuery shorthand `{ queryFn }`.
function queryFn() {
  return fetch('/api/suspense');
}
export function SuspenseList() {
  const { data } = useSuspenseQuery({ queryKey: ['suspense'], queryFn });
  return data;
}
