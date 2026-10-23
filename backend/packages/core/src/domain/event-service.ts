import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { Database } from '../db/connection.js';
import { isEventType, parseEventPayload } from '@workjournal/shared';
import { toEventRow } from './serialize.js';

export interface RecordEventInput {
  projectId: string;
  taskId: string | null;
  actor: string;
  eventType: string;
  payload: unknown;
  idempotencyKey: string;
  /** WS-3 enhanced fields for plugin integration */
  category?: string;
  source?: string;
}

export interface RecordedEvent {
  id: string;
  sequence: number;
  created_at: string;
  eventId: string;
}

/**
 * Append-only per-task history (scope §9).
 * All event writes MUST funnel through this single append() implementation.
 * The caller (task/checkpoint/decision service) owns the transaction so the state change
 * and its event commit together.
 */
export class EventService {
  constructor(private db: Database) {}

  /**
   * Single append entry point for ALL event writes.
   * Enforces:
   * - Strict payload validation via parseEventPayload
   * - Idempotency: same event_id -> return stored outcome, no new row
   * - Strictly monotonic sequence: per-task for task-scoped events, per-project-partition for task_id NULL events
   * - Append-only: no UPDATE/DELETE on events
   */
  async append(data: RecordEventInput): Promise<{ event: RecordedEvent; duplicate: boolean }> {
    const payload = parseEventPayload(data.eventType, data.payload) as Record<string, unknown>;

    // Idempotency check: if same event_id already exists, return stored outcome
    const existing = this.db.prepare
      .prepare('SELECT id, sequence, created_at, event_id FROM events WHERE event_id = ?')
      .get(data.idempotencyKey) as any;

    if (existing?.id) {
      return { event: { id: existing.id, sequence: existing.sequence, created_at: existing.created_at, eventId: existing.event_id }, duplicate: true };
    }

    // Determine sequence: per-task for task-scoped, per-project-partition for task_id NULL
    let sequence: number;
    if (data.taskId) {
      const lastSeq = this.db.prepare
        .prepare('SELECT MAX(sequence) as max_seq FROM events WHERE task_id = ?')
        .get(data.taskId) as any;
      sequence = (lastSeq?.max_seq || 0) + 1;
    } else {
      // Per-project partition for task_id NULL events
      const lastSeq = this.db.prepare
        .prepare('SELECT MAX(sequence) as max_seq FROM events WHERE task_id IS NULL AND project_id = ?')
        .get(data.projectId) as any;
      sequence = (lastSeq?.max_seq || 0) + 1;
    }

    const id = uuid();
    const now = new Date().toISOString();
    const category = data.category || 'task';
    const source = data.source || 'core';

    this.db.prepare
      .prepare(
        `INSERT INTO events (id, project_id, task_id, sequence, actor, event_type, payload, created_at, event_id, category, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.projectId, data.taskId, sequence, data.actor, data.eventType, JSON.stringify(payload), now, data.idempotencyKey, category, source);

    return { event: { id, sequence, created_at: now, eventId: data.idempotencyKey }, duplicate: false };
  }

  listEvents(taskId: string | null, limit = 100, offset = 0, filters?: { category?: string; source?: string; projectId?: string }) {
    let where = '';
    let params: any[] = [];
    
    if (taskId) {
      where = 'task_id = ?';
      params = [taskId];
    } else {
      where = 'task_id IS NULL';
      params = [];
    }
    
    // Add project_id filter for task-less events
    if (filters?.projectId && taskId === null) {
      where += ' AND project_id = ?';
      params.push(filters.projectId);
    }
    
    // Add category filter
    if (filters?.category) {
      where += ' AND category = ?';
      params.push(filters.category);
    }
    
    // Add source filter
    if (filters?.source) {
      where += ' AND source = ?';
      params.push(filters.source);
    }
    
    return (this.db.prepare
      .prepare(`SELECT * FROM events WHERE ${where} ORDER BY sequence ASC LIMIT ? OFFSET ?`)\n      .all(...params, limit, offset) as any[]).map(toEventRow);
  }

  getEventsSince(taskId: string | null, sinceSequence: number) {
    const taskWhere = taskId ? `task_id = ?` : `task_id IS NULL`;
    return (this.db.prepare
      .prepare(`SELECT * FROM events WHERE ${taskWhere} AND sequence > ? ORDER BY sequence ASC`)
      .all(taskId || null, sinceSequence) as any[]).map(toEventRow);
  }
}
