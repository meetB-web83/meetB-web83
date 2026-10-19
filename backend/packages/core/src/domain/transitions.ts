import type { TaskStatus } from '@workjournal/shared';
import { TaskStatus as TS } from '@workjournal/shared';

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TS.Open]: [TS.InProgress, TS.Cancelled],
  [TS.InProgress]: [TS.Open, TS.Blocked, TS.Completed, TS.Cancelled, TS.Interrupted],
  [TS.Blocked]: [TS.Open, TS.Cancelled],
  [TS.Interrupted]: [TS.InProgress, TS.Open, TS.Cancelled],
  [TS.Completed]: [],
  [TS.Cancelled]: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from] ?? [];
}
