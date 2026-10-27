import { z } from 'zod';

/**
 * POST /api/ingest/events request contract (spec M10, decisions D-023).
 *
 * One request covers ONE project (the `project_id` query parameter — batches
 * come from one agent working in one project); envelopes carry the remaining
 * canonical fields. `category` is never accepted from clients: Core derives it
 * from the event type (single source of truth, shared/src/types/events.ts).
 * Project scope is request-level rather than per-envelope — the stored envelope
 * (eventResponseSchema) still carries project_id.
 */

/** D-017 source syntax; `core` is reserved for Core-generated events. */
const ingestSourceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'source must be alphanumeric with . _ : - separators')
  .refine((s) => s !== 'core', 'source "core" is reserved for Core-generated events');

export const ingestEnvelopeSchema = z.object({
  /** Client-generated dedup key (D-023): resending it is a no-op. */
  event_id: z.string().min(1).max(200),
  /** Event type string; the route enforces the ingestible allowlist (D-023). */
  type: z.string().min(1).max(100),
  source: ingestSourceSchema,
  actor: z.string().min(1).max(200),
  /** Task scope; omitted → project-level event, backfilled from the session binding when one is active. */
  task_id: z.string().min(1).max(200).optional(),
  /** UTC occurrence time; defaults to Core's recording time. */
  occurred_at: z.string().datetime().optional(),
  /** Validated against the strict per-type payload schema before insert. */
  payload: z.record(z.unknown()),
});

export const ingestBatchSchema = z.object({
  events: z.array(ingestEnvelopeSchema).min(1).max(50),
});

export const ingestEventResultSchema = z.object({
  event_id: z.string(),
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  /** Row id and assigned sequence — present when accepted or duplicate. */
  id: z.string().optional(),
  sequence: z.number().int().optional(),
  /** Effective task scope after session-binding backfill. */
  task_id: z.string().nullable().optional(),
  /** Rejection reason (payload validation failure etc.). */
  reason: z.string().optional(),
});

export const ingestBatchResultSchema = z.object({
  results: z.array(ingestEventResultSchema),
  accepted: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.number().int(),
});

export type IngestEnvelopeInput = z.infer<typeof ingestEnvelopeSchema>;
export type IngestBatchInput = z.infer<typeof ingestBatchSchema>;
export type IngestEventResult = z.infer<typeof ingestEventResultSchema>;
export type IngestBatchResult = z.infer<typeof ingestBatchResultSchema>;
