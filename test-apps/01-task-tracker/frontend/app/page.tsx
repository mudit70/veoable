import TaskList from '../components/TaskList';
import NewTaskForm from '../components/NewTaskForm';
import { fetchTasks } from '../lib/api';

export default async function HomePage() {
  const tasks = await fetchTasks();
  return (
    <div>
      <NewTaskForm />
      <TaskList initialTasks={tasks} />
    </div>
  );
}
