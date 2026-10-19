export const TaskStatus = {
  Open: 'open',
  InProgress: 'in_progress',
  Blocked: 'blocked',
  Interrupted: 'interrupted',
  Completed: 'completed',
  Cancelled: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Completed,
  TaskStatus.Cancelled,
];

export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Open,
  TaskStatus.InProgress,
  TaskStatus.Blocked,
  TaskStatus.Interrupted,
];
