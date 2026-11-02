import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { EventService } from './event-service.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { NotFoundError } from '@workjournal/shared';
import { toDecisionRow } from './serialize.js';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreateDecisionData {
  taskId: string;
  agentId: string;
  statement: string;
  rationale?: string;
  alternatives?: string[];
  supportingEventIds?: string[];
  idempotency?: MutationIdempotency;
}

export interface SupersedeDecisionData {
  taskId: string;
  decisionId: string;
  agentId: string;
  replacementStatement: string;
  replacementRationale?: string;
  idempotency?: MutationIdempotency;
}

/**
 * Decision writes follow decision D-004 (2026-10-16): no ownership/version enforcement
 * and no task version bump, but every write is atomic with its event and idempotency
 * record. Supersession preserves both rows and links them (scope Â§8).
 */
export class DecisionService {
  private events: EventService;
  private idem: IdempotencyService;

  constructor(private db: Database) {
    this.events = new EventService(db);
    this.idem = new IdempotencyService(db);
  }

  async createDecision(data: CreateDecisionData, agentCall?: boolean) {
    return this.idem.run(
      'idempotency_records',
      data.idempotency && { ...data.idempotency, operation: 'decision.create', actor: data.agentId },
      () => {
        const task = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(data.taskId) as any;
        if (!task) throw new NotFoundError(`Task ${data.taskId} not found`);

        const id = uuid();
        const now = new Date().toISOString();

        this.db.raw
          .prepare(
            `INSERT INTO decisions (id, task_id, statement, rationale, alternatives, supporting_event_ids, status, superseded_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
          )
          .run(
            id,
            data.taskId,
            data.statement,
            data.rationale || null,
            JSON.stringify(data.alternatives || []),
            JSON.stringify(data.supportingEventIds || []),
            now,
          );

        this.events.recordEvent({
          projectId: task.project_id,
          taskId: data.taskId,
          actor: data.agentId,
          eventType: 'decision_recorded',
          payload: { decision_id: id, statement: data.statement },
        });

        return this.getDecision(id, agentCall);
      },
    );
  }

  getDecision(decisionId: string, agentCall?: boolean) {
    const row = this.db.raw.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as any;
    if (!row) throw new NotFoundError(`Decision ${decisionId} not found`);
    return projectDecisionRow(toDecisionRow(row), agentCall);
  }

  listDecisions(taskId: string, includeSuperseded = false, agentCall?: boolean) {
    const rows = includeSuperseded
      ? (this.db.raw
          .prepare('SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at ASC, id ASC')
          .all(taskId) as any[])
      : (this.db.raw
          .prepare("SELECT * FROM decisions WHERE task_id = ? AND status = 'active' ORDER BY created_at ASC, id ASC")
          .all(taskId) as any[]);
    return rows.map((row) => projectDecisionRow(toDecisionRow(row), agentCall));
  }

  async supersedeDecision(data: SupersedeDecisionData, agentCall?: boolean) {
    return this.idem.run(
      'idempotency_records',
      data.idempotency && { ...data.idempotency, operation: 'decision.supersede', actor: data.agentId },
      () => {
        const task = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(data.taskId) as any;
        if (!task) throw new NotFoundError(`Task ${data.taskId} not found`);

        const previous = this.getDecision(data.decisionId);
        if (previous.task_id !== data.taskId) {
          throw new NotFoundError(`Decision ${data.decisionId} does not belong to task ${data.taskId}`);
        }

        const now = new Date().toISOString();
        const newId = uuid();

        this.db.raw
          .prepare("UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE id = ?")
          .run(newId, data.decisionId);

        this.db.raw
          .prepare(
            `INSERT INTO decisions (id, task_id, statement, rationale, alternatives, supporting_event_ids, status, superseded_by, created_at)
             VALUES (?, ?, ?, ?, '[]', '[]', 'active', NULL, ?)`,
          )
          .run(newId, data.taskId, data.replacementStatement, data.replacementRationale || null, now);

        this.events.recordEvent({
          projectId: task.project_id,
          taskId: data.taskId,
          actor: data.agentId,
          eventType: 'decision_superseded',
          payload: {
            previous_decision_id: data.decisionId,
            replacement_decision_id: newId,
          },
        });

        return this.getDecision(newId, agentCall);
      },
    );
  }
}

/**
 * Project a decision row to the field set needed by the caller.
 * - agentCall=true (MCP agent): minimal fields — id, statement, status, created_at.
 * - agentCall=false (frontend dashboard): fields needed by task detail view.
 * - absent: full row (backward compatible).
 */
function projectDecisionRow(row: Record<string, any>, agentCall?: boolean): Record<string, any> {
  if (agentCall === true) {
    return {
      id: row.id,
      statement: row.statement,
      status: row.status,
      created_at: row.created_at,
    };
  }
  if (agentCall === false) {
    return {
      id: row.id,
      task_id: row.task_id,
      statement: row.statement,
      rationale: row.rationale,
      status: row.status,
      created_at: row.created_at,
    };
  }
  return row;
}
