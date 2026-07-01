import React, { useEffect, useState } from 'react';

interface Note {
  id: number;
  title: string;
  body: string;
}

export default function NoteList() {
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    fetch('/api/notes')
      .then((res) => res.json())
      .then(setNotes);
  }, []);

  const handleCreate = async () => {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Note', body: '' }),
    });
    const note = await res.json();
    setNotes([...notes, note]);
  };

  const handleDelete = async (id: number) => {
    await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    setNotes(notes.filter((n) => n.id !== id));
  };

  return (
    <div>
      <h1>Notes</h1>
      <button onClick={handleCreate}>Add Note</button>
      {notes.map((n) => (
        <div key={n.id}>
          <strong>{n.title}</strong>
          <button onClick={() => handleDelete(n.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
