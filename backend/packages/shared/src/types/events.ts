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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Payload schema per event type. Validated before the event row is inserted. */
export const eventPayloadSchemas = {
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
