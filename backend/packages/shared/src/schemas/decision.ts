import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';
import { queryBoolean } from './query.js';

export const DecisionStatus = {
  Active: 'active',
  Superseded: 'superseded',
} as const;

export type DecisionStatus = (typeof DecisionStatus)[keyof typeof DecisionStatus];

export const createDecisionSchema = z.object({
  task_id: z.string().min(1),
  agent_id: z.string().min(1).max(200),
  statement: z.string().min(1).max(2000),
  rationale: z.string().max(5000).optional(),
  alternatives: z.array(z.string().max(1000)).max(20).optional(),
  supporting_event_ids: z.array(z.string()).max(50).optional(),
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
});

export const supersedeDecisionSchema = z.object({
  task_id: z.string().min(1),
  agent_id: z.string().min(1).max(200),
  decision_id: z.string().min(1),
  replacement_statement: z.string().min(1).max(2000),
  replacement_rationale: z.string().max(5000).optional(),
  expected_version: z.number().int().positive(),
  idempotency_key: idempotencyKeySchema,
});

export const decisionResponseSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  statement: z.string(),
  rationale: z.string().nullable(),
  alternatives: z.array(z.string()),
  supporting_event_ids: z.array(z.string()),
  status: z.nativeEnum(DecisionStatus),
  superseded_by: z.string().nullable(),
  created_at: z.string(),
});

export const listDecisionsQuerySchema = z.object({
  task_id: z.string().min(1),
  include_superseded: queryBoolean.default(false),
});

export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
export type SupersedeDecisionInput = z.infer<typeof supersedeDecisionSchema>;
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;
export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;
