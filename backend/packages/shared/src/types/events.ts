import { z } from 'zod';

/**
 * Canonical event model (plan §3 / spec M3, WS-2).
 *
 * One type table covers the task ledger and the agent ledger; every type maps
 * to exactly one category via EVENT_CATEGORY_BY_TYPE (single source of truth —
 * clients never supply a category). No payload schema allows an agent event to
 * set task status: the transition function stays the only path that mutates
 * task state (D-017/D-023).
 */

export const EVENT_TYPES = [
  // task — authoritative lifecycle, recorded by Core only
  'task_created',
  'task_updated',
  'task_claimed',
  'task_released',
  'task_transitioned',
  // decision
  'decision_recorded',
  'decision_superseded',
  // recovery
  'checkpoint_recorded',
  'recovery_started',
  'recovery_completed',
  // agent — lifecycle, interruption, timeout, idle (plan §3.2)
  'agent_session_started',
  'agent_session_ended',
  'agent_interrupted',
  'agent_timed_out',
  'agent_idle',
  // agent — observable activity (D-027)
  'agent_tool_call',
  // progress
  'progress_milestone',
  'progress_fulfilment',
  // verification
  'verification_passed',
  'verification_failed',
  'verification_skipped',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_CATEGORIES = [
  'task',
  'agent',
  'progress',
  'decision',
  'verification',
  'recovery',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** Single source of truth: category derived from the event type (plan §3.2). */
export const EVENT_CATEGORY_BY_TYPE = {
  task_created: 'task',
  task_updated: 'task',
  task_claimed: 'task',
  task_released: 'task',
  task_transitioned: 'task',
  decision_recorded: 'decision',
  decision_superseded: 'decision',
  checkpoint_recorded: 'recovery',
  recovery_started: 'recovery',
  recovery_completed: 'recovery',
  agent_session_started: 'agent',
  agent_session_ended: 'agent',
  agent_interrupted: 'agent',
  agent_timed_out: 'agent',
  agent_idle: 'agent',
  agent_tool_call: 'agent',
  progress_milestone: 'progress',
  progress_fulfilment: 'progress',
  verification_passed: 'verification',
  verification_failed: 'verification',
  verification_skipped: 'verification',
} as const satisfies Record<EventType, EventCategory>;

/**
 * Category for any event type. Defined types map through the table above;
 * free-form legacy types (recorded by older Core code paths) default to
 * 'task', matching the events-table column default.
 */
export function categoryForEventType(eventType: string): EventCategory {
  return (EVENT_CATEGORY_BY_TYPE as Record<string, EventCategory>)[eventType] ?? 'task';
}

/**
 * Types accepted by POST /api/ingest/events (D-023: ledger categories only —
 * agent, progress, verification, recovery *signals*). Task-lifecycle,
 * decision and checkpoint events are Core-generated and never ingestible.
 */
export const INGESTIBLE_EVENT_TYPES = [
  'agent_session_started',
  'agent_session_ended',
  'agent_interrupted',
  'agent_timed_out',
  'agent_idle',
  'agent_tool_call',
  'progress_milestone',
  'progress_fulfilment',
  'verification_passed',
  'verification_failed',
  'verification_skipped',
  'recovery_started',
  'recovery_completed',
] as const;

export type IngestibleEventType = (typeof INGESTIBLE_EVENT_TYPES)[number];

export function isIngestibleType(value: string): value is IngestibleEventType {
  return (INGESTIBLE_EVENT_TYPES as readonly string[]).includes(value);
}

/** Bounded free-text field (plan §3.3). */
const boundedText = (max: number) => z.string().min(1).max(max);

const agentIdField = boundedText(200);
const sessionIdField = boundedText(200);
const optionalDetail = boundedText(10000).optional();

/**
 * Payload schema per event type. Validated before the event row is inserted.
 *
 * Pre-existing (MVP) types keep their original schemas; every WS-2 addition is
 * STRICT (unknown keys rejected) and none of them carries a `status` field —
 * agent events are ledger entries, never task transitions (M3 §2).
 */
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
  agent_session_started: z
    .object({ agent_id: agentIdField, session_id: sessionIdField })
    .strict(),
  agent_session_ended: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField,
      reason: z.enum(['completed', 'interrupted', 'failed', 'timeout']),
      // D-027 run summary — optional so plugins older than v3 stay valid.
      duration_ms: z.number().int().nonnegative().optional(),
      iterations: z.number().int().nonnegative().optional(),
      tool_call_count: z.number().int().nonnegative().optional(),
      failed_tool_call_count: z.number().int().nonnegative().optional(),
      files_touched: z.array(boundedText(1024)).max(100).optional(),
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .strict(),
  agent_interrupted: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField,
      reason: boundedText(2000).optional(),
    })
    .strict(),
  agent_timed_out: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField,
      timeout_ms: z.number().int().nonnegative().optional(),
    })
    .strict(),
  // Plan §10.11: agent_idle is a WS-2 addition (checkpoint-evaluation signal, WS-5).
  agent_idle: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField,
      idle_for_ms: z.number().int().nonnegative().optional(),
    })
    .strict(),
  /**
   * One completed tool call (D-027). `target` is the tool's file path or
   * command after secret redaction and truncation; it is never the raw input
   * object. High-volume by nature — the plugin emits one row per call.
   */
  agent_tool_call: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField,
      tool: boundedText(200),
      status: z.enum(['succeeded', 'failed']),
      duration_ms: z.number().int().nonnegative(),
      target: boundedText(1024).optional(),
      tool_call_id: boundedText(200).optional(),
    })
    .strict(),
  progress_milestone: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      summary: boundedText(2000),
    })
    .strict(),
  progress_fulfilment: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      summary: boundedText(2000),
      findings: optionalDetail,
      blockers: boundedText(5000).optional(),
      next_steps: boundedText(5000).optional(),
      files_changed: z.array(boundedText(1024)).max(100).optional(),
    })
    .strict(),
  verification_passed: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      check_type: boundedText(200),
      detail: optionalDetail,
    })
    .strict(),
  verification_failed: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      check_type: boundedText(200),
      detail: optionalDetail,
    })
    .strict(),
  verification_skipped: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      check_type: boundedText(200),
      detail: optionalDetail,
    })
    .strict(),
  recovery_started: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      summary: boundedText(2000).optional(),
    })
    .strict(),
  recovery_completed: z
    .object({
      agent_id: agentIdField,
      session_id: sessionIdField.optional(),
      summary: boundedText(2000).optional(),
    })
    .strict(),
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
