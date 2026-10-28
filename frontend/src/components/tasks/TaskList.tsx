import { Link, useLocation } from 'react-router-dom';
import { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import { StatusBadge } from '../ui/StatusBadge';
import { PriorityBadge } from '../ui/PriorityBadge';
import { Spinner } from '../ui/Spinner';
import { EmptyState } from '../ui/EmptyState';
import { formatRelative } from '../../lib/format';

interface TaskListProps {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  view?: 'cards' | 'list';
}

export function TaskList({ tasks, loading, error, view = 'cards' }: TaskListProps) {
  const location = useLocation();
  if (loading) return <Spinner />;
  if (error) return <EmptyState title="Error loading tasks" description={error} />;
  if (tasks.length === 0) return <EmptyState title="No tasks found" description="Create a task to get started." />;

  if (view === 'list') {
    return (
      <div className="task-list">
        {tasks.map((task) => (
          <Link to={`/tasks/${task.id}`} state={{ from: location }} className="task-row" key={task.id}>
            <div className="task-row-main">
              <span className="task-row-title">{task.title}</span>
              <div className="task-row-meta">
                <StatusBadge status={task.status} />
                <PriorityBadge priority={task.priority} />
                {task.owner && <span className="task-row-owner">{task.owner}</span>}
              </div>
            </div>
            <span className="task-row-time">{formatRelative(task.updated_at)}</span>
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div className="task-grid">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  );
}
