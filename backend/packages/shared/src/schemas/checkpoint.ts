import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';

export const createCheckpointSchema = z.object({
  task_id: z.string().min(1),
  agent_id: z.string().min(1).max(200),
  progress_summary: z.string().min(1).max(5000),
  completed_work: z.string().max(10000).optional(),
  current_findings: z.string().max(10000).optional(),
  unresolved_issues: z.string().max(10000).optional(),
  next_steps: z.string().max(5000).optional(),
  file_references: z.array(z.string().max(1024)).max(50).optional(),
  idempotency_key: idempotencyKeySchema,
  /** When true (MCP agent call), response is projected to agent-minimal fields. */
  agentCall: z.preprocess(
    (value) => (value === 'true' ? true : value === 'false' ? false : value),
    z.boolean().optional(),
  ),
});

export const checkpointResponseSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  progress_summary: z.string(),
  completed_work: z.string().nullable(),
  current_findings: z.string().nullable(),
  unresolved_issues: z.string().nullable(),
  next_steps: z.string().nullable(),
  file_references: z.array(z.string()),
  created_at: z.string(),
});

export const listCheckpointsQuerySchema = z.object({
  task_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** When true (MCP agent call), response is projected to agent-minimal fields. */
  agentCall: z.preprocess(
    (value) => (value === 'true' ? true : value === 'false' ? false : value),
    z.boolean().optional(),
  ),
});

export type CreateCheckpointInput = z.infer<typeof createCheckpointSchema>;
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;
export type ListCheckpointsQuery = z.infer<typeof listCheckpointsQuerySchema>;
