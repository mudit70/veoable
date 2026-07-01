import React, { useEffect, useState } from 'react';

interface Task {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
}

export default function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    fetch('/api/tasks')
      .then((res) => res.json())
      .then(setTasks);
  }, []);

  const handleCreate = async (title: string) => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const task = await res.json();
    setTasks([...tasks, task]);
  };

  const handleUpdateStatus = async (id: number, status: string) => {
    await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  };

  return (
    <div>
      <button onClick={() => handleCreate('New Task')}>Add Task</button>
      {tasks.map((t) => (
        <div key={t.id}>
          <span>{t.title}</span>
          <select value={t.status} onChange={(e) => handleUpdateStatus(t.id, e.target.value)}>
            <option value="todo">Todo</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
          </select>
        </div>
      ))}
    </div>
  );
}
