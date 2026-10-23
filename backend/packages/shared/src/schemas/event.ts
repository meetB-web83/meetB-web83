import { z } from 'zod';

export const eventResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  sequence: z.number().int(),
  actor: z.string(),
  event_type: z.string(),
  payload: z.record(z.unknown()),
  category: z.string(),
  source: z.string(),
  created_at: z.string(),
});

export const listEventsQuerySchema = z.object({
  task_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type EventResponse = z.infer<typeof eventResponseSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
