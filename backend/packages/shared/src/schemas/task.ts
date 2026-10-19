import { z } from 'zod';
import { TaskStatus } from '../types/task-status.js';
import { Priority } from '../types/priority.js';
import { idempotencyKeySchema } from './idempotency.js';

export const agentIdSchema = z.string().min(1).max(200);

export const createTaskSchema = z.object({
  project_id: z.string().min(1),
  agent_id: agentIdSchema,
  title: z.string().min(1).max(500),
  objective: z.string().max(5000).optional(),
  acceptance_criteria: z.array(z.string().max(1000)).max(50).optional(),
  priority: z.nativeEnum(Priority).default(Priority.Medium),
  idempotency_key: idempotencyKeySchema,
});

export const updateTaskSchema = z.object({
  agent_id: agentIdSchema,
  title: z.string().min(1).max(500).optional(),
  objective: z.string().max(5000).optional(),
  acceptance_criteria: z.array(z.string().max(1000)).max(50).optional(),
  priority: z.nativeEnum(Priority).optional(),
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
});

export const claimTaskSchema = z.object({
  task_id: z.string().min(1),
  agent_id: agentIdSchema,
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
});

export const releaseTaskSchema = z.object({
  task_id: z.string().min(1),
  agent_id: agentIdSchema,
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
});

export const transitionTaskSchema = z.object({
  task_id: z.string().min(1),
  agent_id: agentIdSchema,
  target_status: z.nativeEnum(TaskStatus),
  reason: z.string().max(2000).optional(),
  resolution_note: z.string().max(2000).optional(),
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
});

export const listTasksQuerySchema = z.object({
  project_id: z.string().min(1).optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  priority: z.nativeEnum(Priority).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Specialised transition inputs for the MCP tools that fix a target status. They share
 * every field with `transitionTaskSchema`; only `target_status` is supplied by the tool
 * itself, and the reason/note requirements of scope §5 are enforced at the shape level.
 */
const transitionBase = transitionTaskSchema.omit({ target_status: true });

export const blockTaskSchema = transitionBase.extend({
  reason: z.string().min(1).max(2000),
});

export const cancelTaskSchema = transitionBase.extend({
  reason: z.string().min(1).max(2000),
});

export const interruptTaskSchema = transitionBase.extend({
  reason: z.string().min(1).max(2000),
});

export const unblockTaskSchema = transitionBase.extend({
  resolution_note: z.string().min(1).max(2000),
});

export const completeTaskSchema = transitionBase.omit({ reason: true, resolution_note: true });

export const taskResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  objective: z.string().nullable(),
  acceptance_criteria: z.array(z.string()),
  priority: z.nativeEnum(Priority),
  status: z.nativeEnum(TaskStatus),
  owner: z.string().nullable(),
  version: z.number().int(),
  latest_checkpoint_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskSchema>;
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>;
export type TransitionTaskInput = z.infer<typeof transitionTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type TaskResponse = z.infer<typeof taskResponseSchema>;
