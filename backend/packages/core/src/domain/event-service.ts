import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { Database } from '../db/connection.js';
import { isEventType, parseEventPayload } from '@workjournal/shared';
import { toEventRow } from './serialize.js';

export interface RecordEventInput {
  projectId: string;
  taskId: string;
  actor: string;
  eventType: string;
  payload: unknown;
}

export interface RecordedEvent {
  id: string;
  sequence: number;
  created_at: string;
}

const objectPayload = z.record(z.unknown());

/**
 * Payloads of the defined event types are validated against their schema; any other
 * event type (free-form, recorded by an agent or the dashboard) must at least be a
 * JSON object. Validation happens before the insert, inside the caller's transaction.
 */
function validatePayload(eventType: string, payload: unknown): Record<string, unknown> {
  if (isEventType(eventType)) {
    return parseEventPayload(eventType, payload) as Record<string, unknown>;
  }
  return objectPayload.parse(payload ?? {});
}

/**
 * Append-only per-task history (scope Â§9). Never called inside its own transaction:
 * the caller (task/checkpoint/decision service) owns the transaction so the state change
 * and its event commit together.
 */
export class EventService {
  constructor(private db: Database) {}

  recordEvent(data: RecordEventInput): RecordedEvent {
    const payload = validatePayload(data.eventType, data.payload);
    const id = uuid();
    const now = new Date().toISOString();

    const lastSeq = this.db.raw
      .prepare('SELECT MAX(sequence) as max_seq FROM events WHERE task_id = ?')
      .get(data.taskId) as any;
    const sequence = (lastSeq?.max_seq || 0) + 1;

    this.db.raw
      .prepare(
        `INSERT INTO events (id, project_id, task_id, sequence, actor, event_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.projectId,
        data.taskId,
        sequence,
        data.actor,
        data.eventType,
        JSON.stringify(payload),
        now,
      );

    return { id, sequence, created_at: now };
  }

  listEvents(taskId: string, limit = 100, offset = 0) {
    return (this.db.raw
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?')
      .all(taskId, limit, offset) as any[]).map(toEventRow);
  }

  getEventsSince(taskId: string, sinceSequence: number) {
    return (this.db.raw
      .prepare('SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC')
      .all(taskId, sinceSequence) as any[]).map(toEventRow);
  }
}
