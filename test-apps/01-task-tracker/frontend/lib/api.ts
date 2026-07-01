import type { Task, NewTaskInput } from './types';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE}/api/tasks`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load tasks');
  return res.json();
}

export async function fetchTask(id: string): Promise<Task | null> {
  const res = await fetch(`${BASE}/api/tasks/${id}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to load task');
  return res.json();
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to create task');
  return res.json();
}

export async function completeTask(id: string): Promise<Task> {
  const res = await fetch(`${BASE}/api/tasks/${id}/complete`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to complete task');
  return res.json();
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/tasks/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete task');
}
