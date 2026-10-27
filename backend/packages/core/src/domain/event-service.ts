import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { Database } from '../db/connection.js';
import {
  ValidationError,
  isEventType,
  parseEventPayload,
  categoryForEventType,
} from '@workjournal/shared';
import { toEventRow } from './serialize.js';

/** Legacy call shape kept for existing Core callers (task/checkpoint/decision services). */
export interface RecordEventInput {
  projectId: string;
  taskId: string;
  actor: string;
  eventType: string;
  payload: unknown;
}

/**
 * Canonical append input (M3 §2). `taskId` is nullable for project-level
 * events; `eventId` is the client-generated ingestion dedup key (D-023);
 * `occurredAt` separates occurrence from recording time.
 */
export interface AppendEventInput {
  projectId: string;
  taskId: string | null;
  actor: string;
  source: string;
  eventType: string;
  payload: unknown;
  eventId?: string | null;
  occurredAt?: string | null;
}

export interface AppendedEvent {
  id: string;
  event_id: string | null;
  sequence: number;
  created_at: string;
  occurred_at: string;
  duplicate: boolean;
}

/** Legacy result shape (pre-002 callers destructure these three fields). */
export interface RecordedEvent {
  id: string;
  sequence: number;
  created_at: string;
}

export interface ListEventsFilter {
  taskId?: string;
  /** Project-level (task-less) history scope. Exactly one of taskId/projectId. */
  projectId?: string;
  category?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

const objectPayload = z.record(z.unknown());

/**
 * Payloads of the defined event types are validated against their strict
 * per-type schema; any other event type (free-form, recorded by older Core
 * paths) must at least be a JSON object. Validation happens before the
 * insert, inside the caller's transaction.
 */
function validatePayload(eventType: string, payload: unknown): Record<string, unknown> {
  if (isEventType(eventType)) {
    return parseEventPayload(eventType, payload) as Record<string, unknown>;
  }
  return objectPayload.parse(payload ?? {});
}

/**
 * Append-only event ledger (root AGENTS.md invariant #3, scope §9).
 *
 * `append()` is THE single funnel (plan §3.4 / M3 §5): payload validation,
 * category derivation, sequence assignment, event_id idempotency and
 * task/project scope all live here. `recordAgentEvent` & friends are thin
 * wrappers over it. Never called inside its own transaction: the caller
 * (task/checkpoint/decision service, or the ingest service) owns the
 * transaction so the state change and its events commit together.
 */
export class EventService {
  constructor(private db: Database) {}

  /** The canonical funnel. See class doc; all record* methods end here. */
  append(input: AppendEventInput): AppendedEvent {
    const payload = validatePayload(input.eventType, input.payload);
    const category = categoryForEventType(input.eventType);

    if (input.eventId) {
      const existing = this.findByEventId(input.eventId);
      if (existing) return { ...toAppended(existing), duplicate: true };
    }

    const id = uuid();
    const now = new Date().toISOString();
    const occurredAt = input.occurredAt ?? now;
    const sequence = this.nextSequence(input.projectId, input.taskId);

    try {
      this.db.raw
        .prepare(
          `INSERT INTO events (id, project_id, task_id, sequence, actor, event_type, category, source, payload, event_id, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.taskId ?? null,
          sequence,
          input.actor,
          input.eventType,
          category,
          input.source,
          JSON.stringify(payload),
          input.eventId ?? null,
          occurredAt,
          now,
        );
    } catch (err: any) {
      // Concurrent retry with the same event_id: the unique index won the race.
      if (input.eventId && String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) {
        const existing = this.findByEventId(input.eventId);
        if (existing) return { ...toAppended(existing), duplicate: true };
      }
      throw err;
    }

    return {
      id,
      event_id: input.eventId ?? null,
      sequence,
      created_at: now,
      occurred_at: occurredAt,
      duplicate: false,
    };
  }

  /**
   * Legacy Core path (task/checkpoint/decision services): source `core`,
   * no client event_id. Kept so existing callers and their tests stay stable.
   */
  recordEvent(data: RecordEventInput): RecordedEvent {
    const result = this.append({
      projectId: data.projectId,
      taskId: data.taskId,
      actor: data.actor,
      source: 'core',
      eventType: data.eventType,
      payload: data.payload,
    });
    return { id: result.id, sequence: result.sequence, created_at: result.created_at };
  }

  /** WS-2 ledger wrappers (plan §3.4) — thin funnels over append(). */
  recordAgentEvent(
    input: Omit<AppendEventInput, 'source' | 'taskId'> & { taskId?: string | null },
  ): AppendedEvent {
    return this.append({ ...input, taskId: input.taskId ?? null, source: `agent:${input.actor}` });
  }

  recordProgressEvent(
    input: Omit<AppendEventInput, 'source' | 'taskId'> & { taskId?: string | null },
  ): AppendedEvent {
    return this.append({ ...input, taskId: input.taskId ?? null, source: `agent:${input.actor}` });
  }

  recordVerificationEvent(
    input: Omit<AppendEventInput, 'source' | 'taskId'> & { taskId?: string | null },
  ): AppendedEvent {
    return this.append({ ...input, taskId: input.taskId ?? null, source: `agent:${input.actor}` });
  }

  recordRecoveryEvent(
    input: Omit<AppendEventInput, 'source' | 'taskId'> & { taskId?: string | null },
  ): AppendedEvent {
    return this.append({ ...input, taskId: input.taskId ?? null, source: `agent:${input.actor}` });
  }

  /**
   * Deterministic listing (WS-3.1): one scope — `taskId` for a task timeline,
   * `projectId` for the project-level (task-less) history — plus optional
   * category/source filters, ordered by the per-scope monotonic sequence.
   */
  listEvents(filter: ListEventsFilter) {
    if (!filter.taskId && !filter.projectId) {
      throw new ValidationError('listEvents requires exactly one scope: taskId or projectId.');
    }

    let query = 'SELECT * FROM events WHERE ';
    const params: any[] = [];
    if (filter.taskId) {
      query += 'task_id = ?';
      params.push(filter.taskId);
    } else {
      query += 'project_id = ? AND task_id IS NULL';
      params.push(filter.projectId);
    }
    if (filter.category) {
      query += ' AND category = ?';
      params.push(filter.category);
    }
    if (filter.source) {
      query += ' AND source = ?';
      params.push(filter.source);
    }
    query += ' ORDER BY sequence ASC, id ASC LIMIT ? OFFSET ?';
    params.push(filter.limit ?? 100, filter.offset ?? 0);

    return (this.db.raw.prepare(query).all(...params) as any[]).map(toEventRow);
  }

  getEventsSince(taskId: string, sinceSequence: number) {
    return (this.db.raw
      .prepare('SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC')
      .all(taskId, sinceSequence) as any[]).map(toEventRow);
  }

  /**
   * Sequence is monotonic per scope: per task, or per project for task-less
   * events (plan §3.1) — the two namespaces are independent by design.
   */
  private nextSequence(projectId: string, taskId: string | null): number {
    const row = taskId
      ? (this.db.raw
          .prepare('SELECT MAX(sequence) AS max_seq FROM events WHERE task_id = ?')
          .get(taskId) as any)
      : (this.db.raw
          .prepare(
            'SELECT MAX(sequence) AS max_seq FROM events WHERE project_id = ? AND task_id IS NULL',
          )
          .get(projectId) as any);
    return (row?.max_seq || 0) + 1;
  }

  private findByEventId(eventId: string): Record<string, any> | undefined {
    return this.db.raw.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as any;
  }
}

function toAppended(row: Record<string, any>): AppendedEvent {
  return {
    id: row.id,
    event_id: row.event_id ?? null,
    sequence: row.sequence,
    created_at: row.created_at,
    occurred_at: row.occurred_at ?? row.created_at,
    duplicate: true,
  };
}
