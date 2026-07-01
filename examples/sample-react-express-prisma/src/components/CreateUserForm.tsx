import { useState } from 'react';

export function CreateUserForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name }),
        });
      }}
    >
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <button type="submit">Create user</button>
    </form>
  );
}
