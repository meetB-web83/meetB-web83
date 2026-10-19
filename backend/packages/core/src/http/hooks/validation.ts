import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ZodSchema } from 'zod';
import { ValidationError } from '@workjournal/shared';

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      (request as any).body = schema.parse(request.body);
    } catch (err: any) {
      throw new ValidationError(err.message || 'Validation failed');
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      (request as any).query = schema.parse(request.query);
    } catch (err: any) {
      throw new ValidationError(err.message || 'Validation failed');
    }
  };
}

/**
 * The validated input minus the idempotency key: exactly what gets hashed and compared
 * when an idempotency key is replayed (root AGENTS.md: hash excludes the key).
 */
export function operationInput<T extends Record<string, any>>(input: T): Omit<T, 'idempotency_key'> {
  const { idempotency_key: _key, ...rest } = input;
  return rest;
}
