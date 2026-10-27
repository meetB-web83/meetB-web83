import { z } from 'zod';
import { agentIdSchema } from './task.js';
import { idempotencyKeySchema } from './idempotency.js';

/**
 * Input schemas for the agent-reporting MCP tools (plan §3.5, WS-2.6). The
 * adapter turns each tool call into ONE canonical envelope posted to
 * POST /api/ingest/events: `event_id` = idempotency_key (single idempotency
 * mechanism per D-023), `source` = `agent:<agent_id>` (D-017), `actor` =
 * agent_id. None of these tools performs an authoritative task transition.
 */

const sessionIdSchema = z.string().min(1).max(200);

/**
 * All agent-reporting tools share: your agent id, an optional explicit
 * project (derived from the agent-id suffix when omitted — project ids never
 * contain `_`), an optional task scope, and a fresh idempotency key.
 */
const agentReportBase = {
  agent_id: agentIdSchema,
  project_id: z.string().min(1).max(200).optional(),
  task_id: z.string().min(1).max(200).optional(),
  idempotency_key: idempotencyKeySchema,
};

/** Session-lifecycle reports carry a REQUIRED session id (payload schema demands it). */
const sessionRequired = { ...agentReportBase, session_id: sessionIdSchema };

/** Progress/verification reports correlate to a session when one is known. */
const sessionOptional = { ...agentReportBase, session_id: sessionIdSchema.optional() };

export const startAgentSessionSchema = z.object({ ...sessionRequired });

export const endAgentSessionSchema = z.object({
  ...sessionRequired,
  reason: z.enum(['completed', 'interrupted', 'failed', 'timeout']),
});

export const reportInterruptionSchema = z.object({
  ...sessionRequired,
  reason: z.string().min(1).max(2000).optional(),
});

export const reportTimeoutSchema = z.object({
  ...sessionRequired,
  timeout_ms: z.number().int().nonnegative().optional(),
});

export const reportProgressMilestoneSchema = z.object({
  ...sessionOptional,
  summary: z.string().min(1).max(2000),
});

export const reportFulfilmentSchema = z.object({
  ...sessionOptional,
  summary: z.string().min(1).max(2000),
  findings: z.string().min(1).max(10000).optional(),
  blockers: z.string().min(1).max(5000).optional(),
  next_steps: z.string().min(1).max(5000).optional(),
  files_changed: z.array(z.string().min(1).max(1024)).max(100).optional(),
});

export const reportVerificationSchema = z.object({
  ...sessionOptional,
  outcome: z.enum(['passed', 'failed', 'skipped']),
  check_type: z.string().min(1).max(200),
  detail: z.string().min(1).max(10000).optional(),
});

export type StartAgentSessionInput = z.infer<typeof startAgentSessionSchema>;
export type EndAgentSessionInput = z.infer<typeof endAgentSessionSchema>;
export type ReportInterruptionInput = z.infer<typeof reportInterruptionSchema>;
export type ReportTimeoutInput = z.infer<typeof reportTimeoutSchema>;
export type ReportProgressMilestoneInput = z.infer<typeof reportProgressMilestoneSchema>;
export type ReportFulfilmentInput = z.infer<typeof reportFulfilmentSchema>;
export type ReportVerificationInput = z.infer<typeof reportVerificationSchema>;
