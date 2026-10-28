import { z } from 'zod';

export const promptSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  template: z.string(),
  arguments: z.array(z.any()).default([]),
  project_id: z.string().nullable(),
  is_builtin: z.boolean(),
  enabled: z.boolean(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const createPromptSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  template: z.string().min(1),
  arguments: z.array(z.any()).optional(),
  project_id: z.string().optional().nullable(),
  idempotency_key: z.string(),
  agent_id: z.string().optional(),
});

export const updatePromptSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  template: z.string().min(1).optional(),
  arguments: z.array(z.any()).optional(),
  enabled: z.boolean().optional(),
  expected_version: z.number(),
  idempotency_key: z.string(),
});

export const listPromptsQuerySchema = z.object({
  scope: z.enum(['global', 'project']).optional(),
  project_id: z.string().optional(),
  category: z.string().optional(),
  enabled: z.boolean().optional(),
  include_builtin: z.boolean().optional(),
  resolved: z.boolean().optional(),
});

export const togglePromptSchema = z.object({
  enabled: z.boolean(),
  expected_version: z.number(),
  idempotency_key: z.string(),
});

export const previewPromptSchema = z.object({
  args: z.record(z.any()).optional(),
});

export type Prompt = z.infer<typeof promptSchema>;
export type CreatePromptInput = z.infer<typeof createPromptSchema>;
export type UpdatePromptInput = z.infer<typeof updatePromptSchema>;
export type ListPromptsQuery = z.infer<typeof listPromptsQuerySchema>;