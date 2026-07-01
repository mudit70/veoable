import { useEffect, useState } from 'react';

interface User {
  id: number;
  email: string;
  name: string | null;
}

export function UserDetail({ id }: { id: number }) {
  const [user, setUser] = useState<User | null>(null);

  // Template-literal URL → egressConfidence: 'pattern'.
  // The stitcher should match the prefix `/api/users/` to `/api/users/:id`.
  useEffect(() => {
    fetch(`/api/users/${id}`)
      .then((r) => r.json())
      .then(setUser);
  }, [id]);

  return (
    <div>
      <h2>{user?.name ?? user?.email}</h2>

      <button
        onClick={() => {
          fetch(`/api/users/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated Name' }),
          });
        }}
      >
        Update name
      </button>

      <button
        onClick={() => {
          fetch(`/api/users/${id}`, { method: 'DELETE' });
        }}
      >
        Delete user
      </button>
    </div>
  );
}
