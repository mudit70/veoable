import React from 'react';
import { trpc } from './trpc';

export default function TodoApp() {
  const todos = trpc.listTodos.useQuery();
  const createMutation = trpc.createTodo.useMutation();
  const deleteMutation = trpc.deleteTodo.useMutation();
  const toggleMutation = trpc.toggleTodo.useMutation();

  const handleCreate = async () => {
    await createMutation.mutateAsync({ title: 'New Todo' });
    todos.refetch();
  };

  const handleToggle = async (id: number) => {
    await toggleMutation.mutateAsync({ id });
    todos.refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteMutation.mutateAsync({ id });
    todos.refetch();
  };

  return (
    <div>
      <h1>Todos</h1>
      <button onClick={handleCreate}>Add Todo</button>
      {todos.data?.map((todo) => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => handleToggle(todo.id)}
          />
          <span>{todo.title}</span>
          <button onClick={() => handleDelete(todo.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
