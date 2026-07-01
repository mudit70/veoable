'use client';

import Link from 'next/link';
import type { Task } from '../lib/types';

interface Props {
  task: Task;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function TaskItem({ task, onComplete, onDelete }: Props) {
  return (
    <li style={{ padding: 8, borderBottom: '1px solid #eee' }}>
      <Link href={`/tasks/${task.id}`}>
        <strong>{task.title}</strong>
      </Link>
      <span style={{ marginLeft: 8 }}>{task.completed ? '✓' : ''}</span>
      <button onClick={() => onComplete(task.id)} disabled={task.completed}>
        Complete
      </button>
      <button onClick={() => onDelete(task.id)}>Delete</button>
    </li>
  );
}
