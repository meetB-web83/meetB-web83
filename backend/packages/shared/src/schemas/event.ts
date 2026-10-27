import { z } from 'zod';
import { EVENT_CATEGORIES } from '../types/events.js';

/**
 * Canonical event envelope as stored and returned by Core (M3 §2). `task_id`
 * is nullable (project-level events), `category` is derived by Core from the
 * event type, and `source` records who produced the event (`core`,
 * `mcp_tool`, `agent:<agent-id>`).
 */
export const eventResponseSchema = z.object({
  id: z.string(),
  event_id: z.string().nullable(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  sequence: z.number().int(),
  actor: z.string(),
  event_type: z.string(),
  category: z.enum(EVENT_CATEGORIES),
  source: z.string(),
  payload: z.record(z.unknown()),
  occurred_at: z.string(),
  created_at: z.string(),
});

/**
 * GET /api/events filters (plan §4, WS-3.1). Exactly one scope is required —
 * `task_id` for a task timeline, `project_id` for the project-level (task-less)
 * history; the route enforces the choice so this schema stays a plain object
 * (the MCP adapter spreads `.shape` into tool input schemas).
 */
export const listEventsQuerySchema = z.object({
  task_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  category: z.enum(EVENT_CATEGORIES).optional(),
  source: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type EventResponse = z.infer<typeof eventResponseSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
