'use client';

import { useState } from 'react';
import type { Task } from '../lib/types';
import { completeTask, deleteTask } from '../lib/api';
import TaskItem from './TaskItem';

export default function TaskList({ initialTasks }: { initialTasks: Task[] }) {
  const [tasks, setTasks] = useState(initialTasks);

  async function handleComplete(id: string) {
    const updated = await completeTask(id);
    setTasks((cur) => cur.map((t) => (t.id === id ? updated : t)));
  }

  async function handleDelete(id: string) {
    await deleteTask(id);
    setTasks((cur) => cur.filter((t) => t.id !== id));
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} onComplete={handleComplete} onDelete={handleDelete} />
      ))}
    </ul>
  );
}
