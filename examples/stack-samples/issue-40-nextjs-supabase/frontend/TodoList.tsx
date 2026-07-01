// Supabase client-side queries — the visitor must detect these as DB interactions
import React, { useEffect, useState } from 'react';
import { supabase } from './supabase';

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

export default function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([]);

  useEffect(() => {
    // SELECT from todos — framework-supabase should emit DatabaseInteraction(read)
    supabase
      .from('todos')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => setTodos(data ?? []));
  }, []);

  const handleAdd = async (title: string) => {
    // INSERT into todos — framework-supabase should emit DatabaseInteraction(write)
    const { data } = await supabase
      .from('todos')
      .insert({ title, completed: false })
      .select()
      .single();
    if (data) setTodos([data, ...todos]);
  };

  const handleToggle = async (id: number, completed: boolean) => {
    // UPDATE todos — framework-supabase should emit DatabaseInteraction(write)
    await supabase
      .from('todos')
      .update({ completed: !completed })
      .eq('id', id);
    setTodos(todos.map((t) => (t.id === id ? { ...t, completed: !completed } : t)));
  };

  const handleDelete = async (id: number) => {
    // DELETE from todos — framework-supabase should emit DatabaseInteraction(delete)
    await supabase.from('todos').delete().eq('id', id);
    setTodos(todos.filter((t) => t.id !== id));
  };

  return (
    <div>
      <h1>Todos</h1>
      <button onClick={() => handleAdd('New todo')}>Add</button>
      {todos.map((todo) => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => handleToggle(todo.id, todo.completed)}
          />
          <span>{todo.title}</span>
          <button onClick={() => handleDelete(todo.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
