import type { Database } from '../db/connection.js';
import { CheckpointService } from './checkpoint-service.js';
import {
  SnapshotService,
  type RollbackContext,
  type RollbackInfo,
  type TaskSnapshotRow,
} from './snapshot-service.js';

/**
 * Read-time rollback view shared by the resume builder and both exporters
 * (Addendum B §B7/B8): the working checkpoint, the rolled-back checkpoints and
 * the derived rollback notice all come from ONE derivation so resume context,
 * JSON and Markdown exports can never disagree on classification (spec §11).
 *
 * Nothing here is stored — checkpoints and events are never mutated.
 */
export interface RollbackView {
  rb: RollbackContext;
  /** Checkpoint ids covered by a rollback (derived from snapshot ranges). */
  rolledBackCheckpointIds: Set<string>;
  /** Every checkpoint of the task, newest first (created_at DESC, id ASC). */
  allCheckpoints: Array<Record<string, any>>;
  /** Newest non-rolled-back checkpoint (created_at DESC, id ASC), full row. */
  workingCheckpoint: Record<string, any> | null;
  /** Rolled-back checkpoints, newest first, full rows. */
  rolledBackCheckpoints: Array<Record<string, any>>;
  /** Most recent rollback, or null when the task has never been rolled back. */
  latestRollback: RollbackInfo | null;
  snapshotById: Map<string, TaskSnapshotRow>;
}

export function getRollbackView(db: Database, taskId: string): RollbackView {
  const snapshots = new SnapshotService(db);
  const checkpoints = new CheckpointService(db);

  const rb = snapshots.getRollbackContext(taskId);

  const rolledBackCheckpointIds = new Set<string>();
  for (const s of rb.snapshots) {
    if (rb.rolledBackIds.has(s.id) && s.kind === 'checkpoint' && s.checkpoint_id) {
      rolledBackCheckpointIds.add(s.checkpoint_id);
    }
  }

  // Full rows (no agent projection): exporters need all detail fields.
  const list = checkpoints.listCheckpoints(taskId, 500, 0) as Array<Record<string, any>>;
  const workingCheckpoint = list.find((c) => !rolledBackCheckpointIds.has(c.id)) ?? null;
  const rolledBackCheckpoints = list.filter((c) => rolledBackCheckpointIds.has(c.id));
  const latestRollback = rb.rollbacks[rb.rollbacks.length - 1] ?? null;

  return {
    rb,
    rolledBackCheckpointIds,
    allCheckpoints: list,
    workingCheckpoint,
    rolledBackCheckpoints,
    latestRollback,
    snapshotById: new Map(rb.snapshots.map((s) => [s.id, s])),
  };
}

/** Checkpoint id → the newest rollback event that covered it (read-time). */
export function rollbackByCheckpointMap(view: RollbackView): Map<string, RollbackInfo> {
  const map = new Map<string, RollbackInfo>();
  for (const r of view.rb.rollbacks) {
    for (const id of r.rolled_back_checkpoint_ids) map.set(id, r);
  }
  return map;
}

/**
 * Attach derived `rolled_back` / `rolled_back_reason` fields to checkpoint list
 * items for the dashboard (Addendum B §B9). Pure read-time annotation — the
 * underlying checkpoint rows are never mutated.
 */
export function annotateRollbackFlags(
  view: RollbackView,
  checkpoints: Array<Record<string, any>>,
): Array<Record<string, any>> {
  const byCheckpoint = rollbackByCheckpointMap(view);
  return checkpoints.map((c) => {
    const r = byCheckpoint.get(c.id);
    return r
      ? { ...c, rolled_back: true, rolled_back_reason: r.reason }
      : { ...c, rolled_back: false };
  });
}
