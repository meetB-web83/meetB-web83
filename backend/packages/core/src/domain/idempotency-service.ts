import { createHash } from 'node:crypto';
import type { Database } from '../db/connection.js';
import { IdempotencyConflictError } from '@workjournal/shared';

/** Where a given operation records its idempotency rows. */
export type IdempotencyTable = 'idempotency_records' | 'registry_idempotency';

/** Idempotency context supplied by the HTTP layer (validated input, without the key). */
export interface IdempotencyOptions {
  key: string;
  operation: string;
  actor: string;
  input: unknown;
}

/** Deterministic JSON: object keys sorted at every depth. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * Every state-changing operation runs through `run()`:
 *
 *   BEGIN IMMEDIATE → idempotency check → state change → event → idempotency record → COMMIT
 *
 * A duplicate key with the same operation, actor and input hash replays the stored
 * response without touching state; anything else raises IDEMPOTENCY_KEY_CONFLICT. Any
 * error rolls the whole thing back, so a rejected call leaves no state change, no event
 * and no idempotency record (root AGENTS.md: idempotency).
 */
export class IdempotencyService {
  constructor(private db: Database) {}

  hashInput(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalize(input)) ?? 'null').digest('hex');
  }

  /** Run `fn` atomically, with idempotency enforcement when `options` is provided. */
  run<T>(table: IdempotencyTable, options: IdempotencyOptions | undefined, fn: () => T): T {
    const selectSql =
      table === 'idempotency_records'
        ? 'SELECT * FROM idempotency_records WHERE key = ?'
        : 'SELECT * FROM registry_idempotency WHERE key = ?';
    const insertSql =
      table === 'idempotency_records'
        ? 'INSERT INTO idempotency_records (key, operation, actor, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO registry_idempotency (key, operation, actor, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)';

    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      if (options) {
        const inputHash = this.hashInput(options.input);
        const existing = this.db.raw.prepare(selectSql).get(options.key) as any;

        if (existing) {
          this.db.raw.exec('ROLLBACK');
          if (
            existing.operation === options.operation &&
            existing.actor === options.actor &&
            existing.input_hash === inputHash
          ) {
            return JSON.parse(existing.response);
          }
          throw new IdempotencyConflictError(
            `Idempotency key "${options.key}" was already used with different input, actor or operation. Use a new key for a new operation.`,
          );
        }

        const result = fn();
        this.db.raw
          .prepare(insertSql)
          .run(
            options.key,
            options.operation,
            options.actor,
            inputHash,
            JSON.stringify(result ?? null),
            new Date().toISOString(),
          );
        this.db.raw.exec('COMMIT');
        return result;
      }

      const result = fn();
      this.db.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // Transaction already rolled back (duplicate-key replay path).
      }
      throw err;
    }
  }
}
