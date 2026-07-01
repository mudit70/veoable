import { useEffect, useState } from 'react';

interface User {
  id: number;
  email: string;
  name: string | null;
}

export function UserList() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then(setUsers);
  }, []);

  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>
          <a href={`/users/${u.id}`}>{u.name ?? u.email}</a>
        </li>
      ))}
    </ul>
  );
}
