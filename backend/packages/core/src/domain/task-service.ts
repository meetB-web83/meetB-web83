import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { EventService } from './event-service.js';
import { SessionBindingService } from './session-binding-service.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { canTransition } from './transitions.js';
import { toTaskRow } from './serialize.js';
import {
  TaskStatus,
  ValidationError,
  NotFoundError,
  StaleVersionError,
  OwnerMismatchError,
  TaskClaimedError,
  InvalidTransitionError,
} from '@workjournal/shared';

/**
 * Idempotency context supplied by the HTTP layer. The service fills in the operation
 * name and the acting agent, so the hash covers the validated input only.
 */
export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreateTaskData {
  projectId: string;
  title: string;
  objective?: string;
  acceptanceCriteria?: string[];
  priority?: string;
  agentId?: string;
  idempotency?: MutationIdempotency;
}

export interface TaskUpdateData {
  title?: string;
  objective?: string;
  acceptanceCriteria?: string[];
  priority?: string;
}

/**
 * All task mutations run through `IdempotencyService.run`, which owns the transaction:
 * state change + event (+ idempotency record) commit or roll back together, and no other
 * code path changes task status.
 */
export class TaskService {
  private events: EventService;
  private bindings: SessionBindingService;
  private idem: IdempotencyService;

  constructor(private db: Database) {
    this.events = new EventService(db);
    this.bindings = new SessionBindingService(db);
    this.idem = new IdempotencyService(db);
  }

  async createTask(data: CreateTaskData) {
    const id = uuid();
    const now = new Date().toISOString();
    const actor = data.agentId ?? 'system';
    const priority = data.priority || 'medium';

    return this.idem.run(
      'idempotency_records',
      data.idempotency && { ...data.idempotency, operation: 'task.create', actor },
      () => {
        this.db.raw
          .prepare(
            `INSERT INTO tasks (id, project_id, title, objective, acceptance_criteria, priority, status, owner, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
          )
          .run(
            id,
            data.projectId,
            data.title,
            data.objective || null,
            JSON.stringify(data.acceptanceCriteria || []),
            priority,
            TaskStatus.Open,
            now,
            now,
          );

        this.events.recordEvent({
          projectId: data.projectId,
          taskId: id,
          actor,
          eventType: 'task_created',
          payload: { title: data.title, priority },
        });

        return this.getTask(id);
      },
    );
  }

  getTask(taskId: string) {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!row) throw new NotFoundError(`Task ${taskId} not found`);
    return toTaskRow(row);
  }

  listTasks(filter: { projectId: string; status?: string; priority?: string; limit: number; offset: number }) {
    let query = 'SELECT * FROM tasks WHERE project_id = ?';
    const params: any[] = [filter.projectId];
    if (filter.status) { query += ' AND status = ?'; params.push(filter.status); }
    if (filter.priority) { query += ' AND priority = ?'; params.push(filter.priority); }
    query += ' ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?';
    params.push(filter.limit, filter.offset);
    return (this.db.raw.prepare(query).all(...params) as any[]).map(toTaskRow);
  }

  async updateTask(
    taskId: string,
    agentId: string,
    expectedVersion: number,
    updates: TaskUpdateData,
    idempotency?: MutationIdempotency,
  ) {
    return this.idem.run(
      'idempotency_records',
      idempotency && { ...idempotency, operation: 'task.update', actor: agentId },
      () => {
        const task = this.getTask(taskId);
        if (task.version !== expectedVersion) {
          throw new StaleVersionError(`Expected version ${expectedVersion}, found ${task.version}. Re-read the task and retry.`);
        }
        if (task.owner && task.owner !== agentId) {
          throw new OwnerMismatchError(`Task is owned by ${task.owner}; only the current owner can update it.`);
        }

        const now = new Date().toISOString();
        const sets: string[] = ['version = version + 1', 'updated_at = ?'];
        const params: any[] = [now];
        const changed: string[] = [];
        if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); changed.push('title'); }
        if (updates.objective !== undefined) { sets.push('objective = ?'); params.push(updates.objective); changed.push('objective'); }
        if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority); changed.push('priority'); }
        if (updates.acceptanceCriteria !== undefined) {
          sets.push('acceptance_criteria = ?');
          params.push(JSON.stringify(updates.acceptanceCriteria));
          changed.push('acceptance_criteria');
        }

        params.push(taskId, expectedVersion);
        this.db.raw
          .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
          .run(...params);

        this.events.recordEvent({
          projectId: task.project_id,
          taskId,
          actor: agentId,
          eventType: 'task_updated',
          payload: { fields: changed },
        });

        return this.getTask(taskId);
      },
    );
  }

  /**
   * Claiming runs through the transition function, so it is permitted exactly where
   * `in_progress` is a legal next status: from `open` (owner must be free) and from
   * `interrupted` (the previous attempt ended, so the claim is reassigned to the
   * recovering agent — scope §18 continuity, Agent A → Agent B).
   *
   * `sessionId` (WS-2.5, from the MCP tool-call `_meta`) binds session → task
   * so later plugin ingestion events for this session carry task_id.
   */
  async claimTask(
    taskId: string,
    agentId: string,
    expectedVersion: number,
    idempotency?: MutationIdempotency,
    sessionId?: string | null,
  ) {
    return this.idem.run(
      'idempotency_records',
      idempotency && { ...idempotency, operation: 'task.claim', actor: agentId },
      () => {
        const task = this.getTask(taskId);
        if (!canTransition(task.status, TaskStatus.InProgress)) {
          throw new InvalidTransitionError(
            `Cannot claim a task in status "${task.status}". Only an open or interrupted task can be claimed.`,
          );
        }
        if (task.version !== expectedVersion) {
          throw new StaleVersionError(`Expected version ${expectedVersion}, found ${task.version}. Re-read the task and retry.`);
        }

        const recovery = task.status === TaskStatus.Interrupted;
        if (task.owner && !recovery) {
          throw new TaskClaimedError(`Task is already claimed by ${task.owner}.`);
        }

        const now = new Date().toISOString();
        this.db.raw
          .prepare(
            `UPDATE tasks SET owner = ?, status = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(agentId, TaskStatus.InProgress, now, taskId, expectedVersion);

        this.events.recordEvent({
          projectId: task.project_id,
          taskId,
          actor: agentId,
          eventType: 'task_claimed',
          payload: { owner: agentId },
        });

        if (sessionId) {
          this.bindings.bind(sessionId, task.project_id, taskId, agentId);
        }

        return this.getTask(taskId);
      },
    );
  }

  async releaseTask(taskId: string, agentId: string, expectedVersion: number, idempotency?: MutationIdempotency) {
    return this.idem.run(
      'idempotency_records',
      idempotency && { ...idempotency, operation: 'task.release', actor: agentId },
      () => {
        const task = this.getTask(taskId);
        if (task.owner !== agentId) {
          throw new OwnerMismatchError(
            task.owner ? `Task is owned by ${task.owner}.` : 'Task has no owner to release.',
          );
        }
        if (task.version !== expectedVersion) {
          throw new StaleVersionError(`Expected version ${expectedVersion}, found ${task.version}. Re-read the task and retry.`);
        }
        if (!canTransition(task.status, TaskStatus.Open)) {
          throw new InvalidTransitionError(`Cannot release a task in status "${task.status}".`);
        }

        const now = new Date().toISOString();
        this.db.raw
          .prepare(
            `UPDATE tasks SET owner = NULL, status = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(TaskStatus.Open, now, taskId, expectedVersion);

        this.events.recordEvent({
          projectId: task.project_id,
          taskId,
          actor: agentId,
          eventType: 'task_released',
          payload: { previous_owner: agentId },
        });

        // WS-2.5: a released task no longer correlates its sessions.
        this.bindings.releaseForTask(taskId);

        return this.getTask(taskId);
      },
    );
  }

  async transitionTask(
    taskId: string,
    agentId: string,
    expectedVersion: number,
    targetStatus: string,
    reason?: string,
    resolutionNote?: string,
    idempotency?: MutationIdempotency,
  ) {
    return this.idem.run(
      'idempotency_records',
      idempotency && { ...idempotency, operation: 'task.transition', actor: agentId },
      () => {
        const task = this.getTask(taskId);

        if (task.owner !== agentId) {
          throw new OwnerMismatchError(
            task.owner ? `Task is owned by ${task.owner}.` : 'Task is unclaimed; claim it before transitioning it.',
          );
        }
        if (task.version !== expectedVersion) {
          throw new StaleVersionError(`Expected version ${expectedVersion}, found ${task.version}. Re-read the task and retry.`);
        }

        // Scope Â§5: cancellation, blocking and interruption require a reason; unblocking
        // records a resolution note.
        if ([TaskStatus.Cancelled, TaskStatus.Blocked, TaskStatus.Interrupted].includes(targetStatus as any)
          && !reason?.trim()) {
          throw new ValidationError(`Transition to "${targetStatus}" requires a reason.`);
        }
        if (targetStatus === TaskStatus.Open && !resolutionNote?.trim()) {
          throw new ValidationError('Unblocking requires a resolution note.');
        }

        if (!canTransition(task.status, targetStatus as any)) {
          throw new InvalidTransitionError(
            `Cannot transition from "${task.status}" to "${targetStatus}".`,
          );
        }

        const now = new Date().toISOString();
        this.db.raw
          .prepare('UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
          .run(targetStatus, now, taskId, expectedVersion);

        this.events.recordEvent({
          projectId: task.project_id,
          taskId,
          actor: agentId,
          eventType: 'task_transitioned',
          payload: {
            from: task.status,
            to: targetStatus,
            ...(reason ? { reason } : {}),
            ...(resolutionNote ? { resolution_note: resolutionNote } : {}),
          },
        });

        return this.getTask(taskId);
      },
    );
  }
}
