import { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';

interface TaskListProps {
  tasks: Task[];
  loading: boolean;
  error: string | null;
}

export function TaskList({ tasks, loading, error }: TaskListProps) {
  if (loading) return <Spinner />;
  if (error) return <EmptyState title="Error loading tasks" description={error} />;
  if (tasks.length === 0) return <EmptyState title="No tasks found" description="Create a task to get started." />;

  return (
    <div className="task-grid">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  );
}
