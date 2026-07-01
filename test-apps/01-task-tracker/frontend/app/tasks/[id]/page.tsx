import { fetchTask } from '../../../lib/api';

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const task = await fetchTask(params.id);
  if (!task) return <p>Not found</p>;
  return (
    <article>
      <h2>{task.title}</h2>
      <p>{task.description}</p>
      <p>Status: {task.completed ? 'done' : 'open'}</p>
    </article>
  );
}
