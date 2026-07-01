import React from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';

const GET_BOOKS = gql`query { books { id title author } }`;
const ADD_BOOK = gql`mutation AddBook($title: String!, $author: String!) { addBook(title: $title, author: $author) { id } }`;
const DELETE_BOOK = gql`mutation DeleteBook($id: Int!) { deleteBook(id: $id) { id } }`;

export default function BookList() {
  const { data, refetch } = useQuery(GET_BOOKS);
  const [addBook] = useMutation(ADD_BOOK);
  const [deleteBook] = useMutation(DELETE_BOOK);

  const handleAdd = async () => {
    await addBook({ variables: { title: 'New Book', author: 'Unknown' } });
    refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteBook({ variables: { id } });
    refetch();
  };

  return (
    <div>
      <h1>Books</h1>
      <button onClick={handleAdd}>Add Book</button>
      {data?.books?.map((book: { id: number; title: string; author: string }) => (
        <div key={book.id}>
          <span>{book.title} by {book.author}</span>
          <button onClick={() => handleDelete(book.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
