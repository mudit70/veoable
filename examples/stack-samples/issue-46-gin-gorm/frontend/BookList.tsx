import React, { useEffect, useState } from 'react';

interface Book {
  id: number;
  title: string;
  author: string;
  isbn: string;
}

export default function BookList() {
  const [books, setBooks] = useState<Book[]>([]);

  useEffect(() => {
    fetch('/api/books')
      .then((res) => res.json())
      .then(setBooks);
  }, []);

  const handleCreate = async (title: string, author: string) => {
    const res = await fetch('/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, isbn: '978-0-00-000000-0' }),
    });
    const book = await res.json();
    setBooks([...books, book]);
  };

  const handleDelete = async (id: number) => {
    await fetch(`/api/books/${id}`, { method: 'DELETE' });
    setBooks(books.filter((b) => b.id !== id));
  };

  return (
    <div>
      <button onClick={() => handleCreate('New Book', 'Author')}>Add Book</button>
      {books.map((b) => (
        <div key={b.id}>
          <span>{b.title} by {b.author}</span>
          <button onClick={() => handleDelete(b.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
