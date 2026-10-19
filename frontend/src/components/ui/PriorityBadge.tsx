const priorityConfig: Record<string, { label: string; variant: string }> = {
  low: { label: 'Low', variant: 'badge-default' },
  medium: { label: 'Medium', variant: 'badge-info' },
  high: { label: 'High', variant: 'badge-error' },
};

export function PriorityBadge({ priority }: { priority: string }) {
  const config = priorityConfig[priority] || { label: priority, variant: 'badge-default' };
  return <span className={`badge ${config.variant}`}>{config.label}</span>;
}
