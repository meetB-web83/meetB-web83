import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { EventService } from './event-service.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { NotFoundError } from '@workjournal/shared';
import { toCheckpointRow } from './serialize.js';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreateCheckpointData {
  taskId: string;
  agentId: string;
  progressSummary: string;
  completedWork?: string;
  currentFindings?: string;
  unresolvedIssues?: string;
  nextSteps?: string;
  fileReferences?: string[];
  idempotency?: MutationIdempotency;
}

/**
 * Checkpoint writes commit atomically with their `checkpoint_recorded` event and
 * their idempotency record. The task must exist; no versioning is enforced.
 */
export class CheckpointService {
  private events: EventService;
  private idem: IdempotencyService;

  constructor(private db: Database) {
    this.events = new EventService(db);
    this.idem = new IdempotencyService(db);
  }

  async createCheckpoint(data: CreateCheckpointData, agentCall?: boolean) {
    return this.idem.run(
      'idempotency_records',
      data.idempotency && { ...data.idempotency, operation: 'checkpoint.create', actor: data.agentId },
      () => {
        const task = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(data.taskId) as any;
        if (!task) throw new NotFoundError(`Task ${data.taskId} not found`);

        const id = uuid();
        const now = new Date().toISOString();

        this.db.raw
          .prepare(
            `INSERT INTO checkpoints (id, task_id, progress_summary, completed_work, current_findings, unresolved_issues, next_steps, file_references, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            data.taskId,
            data.progressSummary,
            data.completedWork || null,
            data.currentFindings || null,
            data.unresolvedIssues || null,
            data.nextSteps || null,
            JSON.stringify(data.fileReferences || []),
            now,
          );

        this.db.raw
          .prepare('UPDATE tasks SET latest_checkpoint_id = ? WHERE id = ?')
          .run(id, data.taskId);

        this.events.recordEvent({
          projectId: task.project_id,
          taskId: data.taskId,
          actor: data.agentId,
          eventType: 'checkpoint_recorded',
          payload: { checkpoint_id: id, progress_summary: data.progressSummary },
        });

        return this.getCheckpoint(id, agentCall);
      },
    );
  }

  getCheckpoint(checkpointId: string, agentCall?: boolean) {
    const row = this.db.raw.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId) as any;
    if (!row) throw new NotFoundError(`Checkpoint ${checkpointId} not found`);
    return projectCheckpointRow(toCheckpointRow(row), agentCall);
  }

  listCheckpoints(taskId: string, limit = 50, offset = 0, agentCall?: boolean) {
    return (this.db.raw
      .prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?')
      .all(taskId, limit, offset) as any[]).map((row) => projectCheckpointRow(toCheckpointRow(row), agentCall));
  }

  getLatestCheckpoint(taskId: string) {
    const row = this.db.raw
      .prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, id ASC LIMIT 1')
      .get(taskId) as any;
    return row ? toCheckpointRow(row) : undefined;
  }
}

/**
 * Project a checkpoint row to the field set needed by the caller.
 * - agentCall=true (MCP agent): minimal fields — id, progress_summary, created_at.
 * - agentCall=false (frontend dashboard): fields needed by task detail view.
 * - absent: full row (backward compatible).
 */
function projectCheckpointRow(row: Record<string, any>, agentCall?: boolean): Record<string, any> {
  if (agentCall === true) {
    return {
      id: row.id,
      progress_summary: row.progress_summary,
      created_at: row.created_at,
    };
  }
  if (agentCall === false) {
    return {
      id: row.id,
      task_id: row.task_id,
      progress_summary: row.progress_summary,
      next_steps: row.next_steps,
      created_at: row.created_at,
    };
  }
  return row;
}
