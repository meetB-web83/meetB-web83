import { Link, useLocation } from 'react-router-dom';
import { Task } from '../../hooks/useTasks';
import { StatusBadge } from '../ui/StatusBadge';
import { PriorityBadge } from '../ui/PriorityBadge';
import { formatRelative } from '../../lib/format';

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  const location = useLocation();
  return (
    <Link to={`/tasks/${task.id}`} state={{ from: location }} className="task-card">
      <div className="task-card-header">
        <StatusBadge status={task.status} />
        <PriorityBadge priority={task.priority} />
      </div>
      <div className="task-card-body">
        <h3 className="task-card-title">{task.title}</h3>
        {task.objective && <p className="task-card-objective">{task.objective}</p>}
      </div>
      <div className="task-card-footer">
        <span className="task-card-meta">v{task.version}</span>
        {task.owner && <span className="task-card-meta">{task.owner}</span>}
        <span className="task-card-meta">{formatRelative(task.updated_at)}</span>
      </div>
    </Link>
  );
}
