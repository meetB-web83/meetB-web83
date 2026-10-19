import { Task } from '../../hooks/useTasks';

const statusConfig: Record<string, { label: string; variant: string }> = {
  open: { label: 'Open', variant: 'badge-default' },
  in_progress: { label: 'In Progress', variant: 'badge-info' },
  blocked: { label: 'Blocked', variant: 'badge-warning' },
  interrupted: { label: 'Interrupted', variant: 'badge-error' },
  completed: { label: 'Completed', variant: 'badge-success' },
  cancelled: { label: 'Cancelled', variant: 'badge-dark' },
};

export function StatusBadge({ status }: { status: Task['status'] }) {
  const config = statusConfig[status] || { label: status, variant: 'badge-default' };
  return <span className={`badge ${config.variant}`}>{config.label}</span>;
}
