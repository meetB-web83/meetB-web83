import { z } from 'zod';
import { IDEMPOTENCY_KEY_PATTERN } from '../constants.js';

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key format');

export const idempotencyRecordSchema = z.object({
  key: idempotencyKeySchema,
  operation: z.string().min(1).max(200),
  actor: z.string().min(1).max(200),
  input_hash: z.string().length(64),
  response: z.record(z.unknown()),
  created_at: z.string(),
});
