import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { EventService } from '../domain/event-service.js';
import type { RollbackInfo } from '../domain/snapshot-service.js';
import { getRollbackView, rollbackByCheckpointMap } from '../domain/rollback-view.js';
import { filterSecretsDeep } from './secret-filter.js';

/** One `revert_applied` event in export shape (spec §11). */
function rollbackBlock(r: RollbackInfo) {
  return {
    target_snapshot_id: r.target_snapshot_id,
    safety_snapshot_id: r.safety_snapshot_id,
    rollback_snapshot_id: r.rollback_snapshot_id,
    reason: r.reason,
    actor: r.actor,
    at: r.created_at,
    rolled_back_checkpoint_ids: r.rolled_back_checkpoint_ids,
  };
}

function checkpointFields(c: Record<string, any>) {
  return {
    id: c.id,
    progress_summary: c.progress_summary,
    completed_work: c.completed_work ?? null,
    current_findings: c.current_findings ?? null,
    unresolved_issues: c.unresolved_issues ?? null,
    next_steps: c.next_steps ?? null,
    file_references: c.file_references ?? [],
    created_at: c.created_at,
  };
}

/**
 * JSON handoff export, format v2 (Addendum B §B8): the working checkpoint,
 * every checkpoint with its derived rolled-back flag, the rollback history and
 * the baseline/effective snapshot refs. Classification comes from the shared
 * `getRollbackView` so it can never disagree with resume or Markdown output.
 * Content passes secret filtering; no raw diffs are embedded.
 */
export class JsonExporter {
  constructor(private db: Database) {}

  async exportTask(taskId: string) {
    const task = await new TaskService(this.db).getTask(taskId);

    const decisions = new DecisionService(this.db);
    const events = new EventService(this.db);

    const view = getRollbackView(this.db, taskId);
    const { rb, allCheckpoints, workingCheckpoint, latestRollback } = view;

    const allDecisions = await decisions.listDecisions(taskId, true);
    const allEvents = await events.listEvents({ taskId });

    // Which rollback covered each checkpoint (newest covering rollback wins).
    const rollbackByCheckpoint = rollbackByCheckpointMap(view);

    const baseline = rb.snapshots.find((s) => s.kind === 'baseline') ?? null;

    const handoff = {
      format_version: 2 as const,
      exported_at: new Date().toISOString(),
      task: {
        id: task.id,
        project_id: task.project_id,
        title: task.title,
        objective: task.objective,
        acceptance_criteria: task.acceptance_criteria,
        status: task.status,
        priority: task.priority,
        owner: task.owner,
      },
      // Working checkpoint: the newest non-rolled-back one (null when none).
      checkpoint: workingCheckpoint ? checkpointFields(workingCheckpoint) : null,
      checkpoints: allCheckpoints.map((c) => {
        const r = rollbackByCheckpoint.get(c.id);
        return {
          ...checkpointFields(c),
          rolled_back: !!r,
          ...(r
            ? {
                rolled_back_by: {
                  rollback_event_id: r.event_id,
                  reason: r.reason,
                  actor: r.actor,
                  at: r.created_at,
                },
              }
            : {}),
        };
      }),
      rollback: {
        present: rb.rollbacks.length > 0,
        latest: latestRollback ? rollbackBlock(latestRollback) : null,
        // Event order (oldest first); `latest` is the final element.
        rollbacks: rb.rollbacks.map(rollbackBlock),
      },
      snapshots: {
        baseline_id: baseline?.id ?? null,
        effective_id: rb.effective?.id ?? null,
        effective_sequence: rb.effective?.sequence ?? null,
        effective_kind: rb.effective?.kind ?? null,
      },
      decisions: allDecisions.map((d: any) => ({
        id: d.id,
        statement: d.statement,
        rationale: d.rationale,
        status: d.status,
        superseded_by: d.superseded_by,
        created_at: d.created_at,
      })),
      events: allEvents.map((e: any) => ({
        id: e.id,
        sequence: e.sequence,
        actor: e.actor,
        event_type: e.event_type,
        payload: e.payload,
        created_at: e.created_at,
      })),
    };

    return filterSecretsDeep(handoff);
  }
}
