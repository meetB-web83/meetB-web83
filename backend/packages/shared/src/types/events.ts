import { z } from 'zod';

/** Event types recorded in the append-only per-task history (scope §9). */
export const EVENT_TYPES = [
  'task_created',
  'task_updated',
  'task_claimed',
  'task_released',
  'task_transitioned',
  'checkpoint_recorded',
  'decision_recorded',
  'decision_superseded',
  // WS-2.2 new types (D-017 / M3 §3.2-3.3)
  'agent_session_started',
  'agent_session_ended',
  'agent_interrupted',
  'agent_timed_out',
  'agent_idle',
  'progress_milestone',
  'progress_fulfilment',
  'verification_passed',
  'verification_failed',
  'verification_skipped',
  'recovery_started',
  'recovery_completed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Payload schema per event type. Validated before the event row is inserted. */
export const eventPayloadSchemas = {
  // Original 8 task-scoped types (unchanged)
  task_created: z.object({
    title: z.string(),
    priority: z.string(),
  }),
  task_updated: z.object({
    fields: z.array(z.string()),
  }),
  task_claimed: z.object({
    owner: z.string(),
  }),
  task_released: z.object({
    previous_owner: z.string(),
  }),
  task_transitioned: z.object({
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
    resolution_note: z.string().optional(),
  }),
  checkpoint_recorded: z.object({
    checkpoint_id: z.string(),
    progress_summary: z.string(),
  }),
  decision_recorded: z.object({
    decision_id: z.string(),
    statement: z.string(),
  }),
  decision_superseded: z.object({
    previous_decision_id: z.string(),
    replacement_decision_id: z.string(),
  }),
  // WS-2.2 new types with strict per-type payload schemas
  agent_session_started: z.object({
    agent_id: z.string(),
    session_id: z.string(),
    config: z.object({
      max_duration_minutes: z.number().int().positive().optional(),
      idempotency_key: z.string().optional(),
    }).optional(),
  }),
  agent_session_ended: z.object({
    agent_id: z.string(),
    session_id: z.string(),
    reason: z.enum(['completed', 'interrupted', 'failed', 'timeout']),
    notes: z.string().optional(),
  }),
  agent_interrupted: z.object({
    agent_id: z.string(),
    session_id: z.string(),
    reason: z.string(),
    notes: z.string().optional(),
  }),
  agent_timed_out: z.object({
    agent_id: z.string(),
    session_id: z.string(),
    max_duration_minutes: z.number().int().positive(),
  }),
  agent_idle: z.object({
    agent_id: z.string(),
    session_id: z.string(),
    duration_minutes: z.number().int().positive(),
  }),
  progress_milestone: z.object({
    agent_id: z.string(),
    milestone: z.string(),
    description: z.string().optional(),
    completed_at: z.string().optional(),
  }),
  progress_fulfilment: z.object({
    agent_id: z.string(),
    deliverable: z.string(),
    delivered_at: z.string(),
    confirmation: z.string().optional(),
  }),
  verification_passed: z.object({
    agent_id: z.string(),
    check_type: z.enum(['syntax', 'type', 'security', 'performance']),
    outcome: z.enum(['pass', 'clear', 'approved']),
    evidence: z.string().optional(),
  }),
  verification_failed: z.object({
    agent_id: z.string(),
    check_type: z.enum(['syntax', 'type', 'security', 'performance']),
    outcome: z.enum(['fail', 'error', 'rejected']),
    rationale: z.string(),
  }),
  verification_skipped: z.object({
    agent_id: z.string(),
    check_type: z.enum(['syntax', 'type', 'security', 'performance']),
    rationale: z.string(),
  }),
  recovery_started: z.object({
    agent_id: z.string(),
    trigger: z.enum(['health_check', 'timeout', 'manual']),
    expected_duration_minutes: z.number().int().positive().optional(),
  }),
  recovery_completed: z.object({
    agent_id: z.string(),
    outcome: z.enum(['recovered', 'escalated', 'failed']),
    resolution: z.string(),
  }),
} satisfies Record<EventType, z.ZodTypeAny>;

export type EventPayloads = {
  [K in EventType]: z.infer<(typeof eventPayloadSchemas)[K]>;
};

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function parseEventPayload<T extends EventType>(
  eventType: T,
  payload: unknown,
): EventPayloads[T] {
  return eventPayloadSchemas[eventType].parse(payload) as EventPayloads[T];
}
