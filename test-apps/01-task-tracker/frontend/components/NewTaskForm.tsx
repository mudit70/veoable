'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTask } from '../lib/api';

export default function NewTaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await createTask({ title, description });
    setTitle('');
    setDescription('');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        required
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
      />
      <button type="submit">Add</button>
    </form>
  );
}
