import { execFileSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import {
  captureWorkingTree,
  diffRefs,
  diffRefVsHead,
  diffWorktreeVsRef,
  isBinaryFile,
  patchRefs,
  type SnapshotCaptureResult,
  snapshotRefName,
} from './git-snapshot.js';
import { EventService } from './event-service.js';
import {
  NotFoundError,
  type GetTaskChangesQuery,
  type TaskChangesResponse,
  type ChangedPath,
  type SnapshotKind,
} from '@workjournal/shared';
import { parseJsonColumn } from './serialize.js';

/** Maximum bytes of a single patch returned through tools (Addendum A §A9). */
const MAX_PATCH_BYTES = 256_000; // 256 KB
/** Maximum bytes of per-file diff content returned through tools. */
const MAX_DIFF_BYTES = 64_000; // 64 KB

export type MutationIdempotency = { key: string; input: unknown };

/** A capture produced by `captureOnly` — persisted later by `recordCaptured`. */
export interface PendingSnapshotCapture {
  id: string;
  taskId: string;
  projectId: string;
  sequence: number;
  kind: string;
  checkpointId: string | null;
  commitSha: string | null;
  refName: string;
  baseHeadSha: string | null;
  branchName: string | null;
  detachedHead: boolean;
  changedFiles: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean; previousPath?: string }>;
  insertions: number;
  deletions: number;
  changedVsBaseline: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean; previousPath?: string }>;
  insertionsVsBaseline: number;
  deletionsVsBaseline: number;
  captureStatus: 'ok' | 'degraded';
  captureReason: string | null;
  excludedPaths: string[];
  capturedAt: string;
  actor: string;
  targetSnapshotId: string | null;
  safetySnapshotId: string | null;
  eventType: 'snapshot_captured' | 'snapshot_failed';
  eventPayload: Record<string, unknown>;
}

export interface CaptureAndRecordInput {
  taskId: string;
  actor: string;
  kind: 'baseline' | 'checkpoint' | 'safety' | 'rollback';
  checkpointId?: string | null;
  rootPath: string;
  /** Previous snapshot of the same task (for diffing). Undefined for baseline. */
  previousSnapshot?: TaskSnapshotRow | null;
  /** Baseline snapshot of the same task (for vs-baseline summary). */
  baselineSnapshot?: TaskSnapshotRow | null;
  /** Rollback linkage (kind='rollback' only): the snapshot being restored… */
  targetSnapshotId?: string | null;
  /** …and the safety snapshot captured before the rollback apply. */
  safetySnapshotId?: string | null;
}

export interface TaskSnapshotRow {
  id: string;
  task_id: string;
  project_id: string;
  sequence: number;
  kind: SnapshotKind;
  checkpoint_id: string | null;
  commit_sha: string | null;
  ref_name: string | null;
  base_head_sha: string | null;
  branch_name: string | null;
  detached_head: boolean;
  changed_files: ChangedPath[];
  insertions: number;
  deletions: number;
  changed_vs_baseline: ChangedPath[];
  insertions_vs_baseline: number;
  deletions_vs_baseline: number;
  capture_status: 'ok' | 'degraded';
  capture_reason: string | null;
  excluded_paths: string[];
  captured_at: string;
  actor: string;
  /** Rollback linkage — set on kind='rollback' snapshots (Addendum B). */
  target_snapshot_id: string | null;
  safety_snapshot_id: string | null;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One `revert_applied` event with its derived rolled-back set (read-time). */
export interface RollbackInfo {
  event_id: string;
  event_sequence: number;
  created_at: string;
  actor: string;
  reason: string;
  target_snapshot_id: string;
  safety_snapshot_id: string;
  rollback_snapshot_id: string;
  target_sequence: number | null;
  safety_sequence: number | null;
  rolled_back_snapshot_ids: string[];
  rolled_back_checkpoint_ids: string[];
}

/** Derived rollback state for a task — never stored, recomputed on every read. */
export interface RollbackContext {
  snapshots: TaskSnapshotRow[];
  rollbacks: RollbackInfo[];
  rolledBackIds: Set<string>;
  effective: TaskSnapshotRow | null;
}

/**
 * Snapshot persistence + capture orchestration (Addendum A, M2/M4).
 *
 * Git capture happens first (outside SQLite). The snapshot row, its event and
 * (for claim/checkpoint) the enclosing state change then commit in one SQLite
 * transaction via the caller's `IdempotencyService.run`. Degraded captures
 * record a `snapshot_failed` event and a degraded row — they never block the
 * enclosing operation (A3).
 *
 * All methods are synchronous so they can be invoked inside the caller's
 * idempotency transaction.
 */
export class SnapshotService {
  private events: EventService;

  constructor(private db: Database) {
    this.events = new EventService(db);
  }

  /** Next per-task snapshot sequence number. */
  private nextSequence(taskId: string): number {
    const row = this.db.raw
      .prepare('SELECT MAX(sequence) AS max_seq FROM task_snapshots WHERE task_id = ?')
      .get(taskId) as any;
    return (row?.max_seq || 0) + 1;
  }

  getSnapshot(id: string): TaskSnapshotRow | null {
    const row = this.db.raw.prepare('SELECT * FROM task_snapshots WHERE id = ?').get(id) as any;
    return row ? toSnapshotRow(row) : null;
  }

  getSnapshotBySeq(taskId: string, sequence: number): TaskSnapshotRow | null {
    const row = this.db.raw
      .prepare('SELECT * FROM task_snapshots WHERE task_id = ? AND sequence = ?')
      .get(taskId, sequence) as any;
    return row ? toSnapshotRow(row) : null;
  }

  listSnapshots(taskId: string, limit = 50, offset = 0): TaskSnapshotRow[] {
    return (this.db.raw
      .prepare(
        'SELECT * FROM task_snapshots WHERE task_id = ? ORDER BY sequence ASC, captured_at ASC LIMIT ? OFFSET ?',
      )
      .all(taskId, limit, offset) as any[]).map(toSnapshotRow);
  }

  getLatestSnapshot(taskId: string): TaskSnapshotRow | null {
    const row = this.db.raw
      .prepare('SELECT * FROM task_snapshots WHERE task_id = ? ORDER BY sequence DESC, captured_at DESC LIMIT 1')
      .get(taskId) as any;
    return row ? toSnapshotRow(row) : null;
  }

  getBaselineSnapshot(taskId: string): TaskSnapshotRow | null {
    const row = this.db.raw
      .prepare(
        'SELECT * FROM task_snapshots WHERE task_id = ? AND kind = ? ORDER BY sequence ASC LIMIT 1',
      )
      .get(taskId, 'baseline') as any;
    return row ? toSnapshotRow(row) : null;
  }

  /** Every snapshot of a task, ascending (append-only order). */
  allSnapshots(taskId: string): TaskSnapshotRow[] {
    return (
      this.db.raw
        .prepare('SELECT * FROM task_snapshots WHERE task_id = ? ORDER BY sequence ASC')
        .all(taskId) as any[]
    ).map(toSnapshotRow);
  }

  /**
   * Rollback derivation for one task (Addendum B §B4/B5) — computed at read
   * time from `revert_applied` events; nothing is ever stored or mutated.
   *
   * A snapshot X is rolled back iff some rollback event e satisfies
   * `seq(target_e) < X.sequence < seq(safety_e)`: the safety snapshot is
   * captured immediately before the post-rollback snapshot, so exactly the
   * snapshots created after the target and before the apply are marked.
   * Ordering: events by sequence, snapshots by sequence — deterministic.
   */
  getRollbackContext(taskId: string): RollbackContext {
    const snapshots = this.allSnapshots(taskId);
    const seqById = new Map(snapshots.map((s) => [s.id, s.sequence]));

    const eventRows = this.db.raw
      .prepare(
        `SELECT id, sequence, actor, payload, created_at FROM events
         WHERE task_id = ? AND event_type = 'revert_applied'
         ORDER BY sequence ASC`,
      )
      .all(taskId) as any[];

    const rollbacks: RollbackInfo[] = [];
    const rolledBackIds = new Set<string>();

    for (const row of eventRows) {
      let payload: any;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue; // defensive: a malformed payload must not break reads
      }
      const targetId = payload?.target_snapshot_id;
      const safetyId = payload?.safety_snapshot_id;
      const rollbackId = payload?.rollback_snapshot_id;
      if (typeof targetId !== 'string' || typeof safetyId !== 'string') continue;

      const targetSeq = seqById.get(targetId) ?? null;
      const safetySeq = seqById.get(safetyId) ?? null;

      const rolledBackSnapshotIds: string[] = [];
      const rolledBackCheckpointIds: string[] = [];
      if (targetSeq !== null && safetySeq !== null) {
        for (const s of snapshots) {
          if (s.sequence > targetSeq && s.sequence < safetySeq) {
            rolledBackSnapshotIds.push(s.id);
            if (s.kind === 'checkpoint') rolledBackCheckpointIds.push(s.id);
          }
        }
        for (const id of rolledBackSnapshotIds) rolledBackIds.add(id);
      }

      rollbacks.push({
        event_id: row.id,
        event_sequence: row.sequence,
        created_at: row.created_at,
        actor: row.actor,
        reason: typeof payload.reason === 'string' ? payload.reason : '',
        target_snapshot_id: targetId,
        safety_snapshot_id: safetyId,
        rollback_snapshot_id: typeof rollbackId === 'string' ? rollbackId : '',
        target_sequence: targetSeq,
        safety_sequence: safetySeq,
        rolled_back_snapshot_ids: rolledBackSnapshotIds,
        rolled_back_checkpoint_ids: rolledBackCheckpointIds,
      });
    }

    const nonRolledBack = snapshots.filter((s) => !rolledBackIds.has(s.id));
    const effective = nonRolledBack[nonRolledBack.length - 1] ?? null;

    return { snapshots, rollbacks, rolledBackIds, effective };
  }

  /**
   * The effective snapshot (B4): the non-rolled-back snapshot with the highest
   * sequence — normally the latest checkpoint, right after a rollback the
   * `rollback` snapshot itself. Drives A5 change sets, A7a drift and plans.
   */
  getEffectiveSnapshot(taskId: string): TaskSnapshotRow | null {
    return this.getRollbackContext(taskId).effective;
  }

  /**
   * Compute a task's change set for one of the supported comparisons (A5).
   * `rootPath` is the project root (git repo) used for live diffs against the
   * working tree or HEAD.
   */
  getTaskChanges(taskId: string, query: GetTaskChangesQuery, rootPath: string): TaskChangesResponse {
    const { comparison, from_snapshot_id, to_snapshot_id, include_diff, include_patch } = query;
    const baseline = this.getBaselineSnapshot(taskId);
    // "Latest" for change semantics = effective snapshot (B4): post-rollback the
    // rollback snapshot is the state the tree actually reflects.
    const latest = this.getEffectiveSnapshot(taskId);

    const resolveRef = (id: string | undefined): TaskSnapshotRow | null =>
      id ? (this.getSnapshot(id) ?? null) : null;

    let fromSnap: TaskSnapshotRow | null = null;
    let toSnap: TaskSnapshotRow | null = null;
    let changedFiles: ChangedPath[] = [];
    let insertions = 0;
    let deletions = 0;
    let drift: TaskChangesResponse['drift'] | undefined;
    let diff: string | undefined;
    let patch: string | undefined;
    let patchTruncated = false;
    let sizeCapped = false;

    const diffRefPair = (a: TaskSnapshotRow, b: TaskSnapshotRow) => {
      const d = diffRefs(rootPath, a.commit_sha!, b.commit_sha!);
      changedFiles = d.changedFiles as ChangedPath[];
      insertions = d.insertions;
      deletions = d.deletions;
    };

    switch (comparison) {
      case 'baseline_to_latest': {
        fromSnap = baseline;
        toSnap = latest;
        if (!fromSnap || !toSnap) {
          return SnapshotService.emptyResponse(taskId, 'baseline_to_latest', baseline, latest);
        }
        diffRefPair(fromSnap, toSnap);
        break;
      }
      case 'snapshot_to_snapshot': {
        fromSnap = resolveRef(from_snapshot_id);
        toSnap = resolveRef(to_snapshot_id);
        if (!fromSnap || !toSnap) {
          throw new NotFoundError(
            `Snapshot not found for comparison: from=${from_snapshot_id ?? '<missing>'} to=${to_snapshot_id ?? '<missing>'}`,
          );
        }
        diffRefPair(fromSnap, toSnap);
        break;
      }
      case 'vs_worktree': {
        fromSnap = latest;
        if (!fromSnap) {
          return SnapshotService.emptyResponse(taskId, 'vs_worktree', baseline, latest);
        }
        const d = diffWorktreeVsRef(rootPath, fromSnap.commit_sha!);
        changedFiles = d.changedFiles as ChangedPath[];
        insertions = d.insertions;
        deletions = d.deletions;
        drift = {
          changed_files: d.changedFiles as ChangedPath[],
          insertions: d.insertions,
          deletions: d.deletions,
          live: true,
        };
        break;
      }
      case 'vs_head': {
        fromSnap = latest;
        if (!fromSnap || !latest) {
          return SnapshotService.emptyResponse(taskId, 'vs_head', baseline, latest);
        }
        const d = diffRefVsHead(rootPath, fromSnap.commit_sha!);
        changedFiles = d.changedFiles as ChangedPath[];
        insertions = d.insertions;
        deletions = d.deletions;
        break;
      }
    }

    if (include_patch && fromSnap && toSnap) {
      const result = patchRefs(rootPath, fromSnap.commit_sha!, toSnap.commit_sha!, MAX_PATCH_BYTES);
      patch = result.patch;
      patchTruncated = result.truncated;
      sizeCapped = result.truncated;
    } else if (include_diff && fromSnap && toSnap) {
      const result = patchRefs(rootPath, fromSnap.commit_sha!, toSnap.commit_sha!, MAX_DIFF_BYTES);
      diff = result.patch;
      sizeCapped = result.truncated;
    }

    return {
      task_id: taskId,
      comparison,
      baseline_snapshot: baseline ?? null,
      latest_snapshot: latest ?? null,
      from_snapshot: fromSnap ?? null,
      to_snapshot: toSnap ?? null,
      changed_files: changedFiles,
      insertions,
      deletions,
      ...(drift ? { drift } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(patch !== undefined ? { patch } : {}),
      patch_truncated: patchTruncated,
      size_capped: sizeCapped,
    };
  }

  private static emptyResponse(
    taskId: string,
    comparison: GetTaskChangesQuery['comparison'],
    baseline: TaskSnapshotRow | null,
    latest: TaskSnapshotRow | null,
  ): TaskChangesResponse {
    return {
      task_id: taskId,
      comparison,
      baseline_snapshot: baseline ?? null,
      latest_snapshot: latest ?? null,
      from_snapshot: null,
      to_snapshot: null,
      changed_files: [],
      insertions: 0,
      deletions: 0,
      patch_truncated: false,
      size_capped: false,
    };
  }

  /** Project id for a task (denormalized onto the snapshot row). */
  private projectIdFor(taskId: string): string {
    const row = this.db.raw.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as any;
    if (!row) throw new NotFoundError(`Task ${taskId} not found`);
    return row.project_id;
  }

  /**
   * Capture the working tree and persist the snapshot row + event.
   * Intended to be called inside the caller's idempotency transaction (claim /
   * checkpoint), so the snapshot record and its event commit atomically with the
   * enclosing state change.
   */
  captureAndRecord(input: CaptureAndRecordInput): TaskSnapshotRow {
    return this.recordCaptured(this.captureOnly(input));
  }

  /**
   * Git-first capture WITHOUT database writes (Addendum B §7.3): returns the
   * pending row + event so a caller can capture two snapshots (safety +
   * post-rollback) and persist them in ONE transaction with the revert event.
   */
  captureOnly(input: CaptureAndRecordInput): PendingSnapshotCapture {
    const { taskId, actor, kind, rootPath, previousSnapshot, baselineSnapshot } = input;
    const sequence = this.nextSequence(taskId);
    const refName = snapshotRefName(taskId, sequence);
    const now = new Date().toISOString();

    // ---- Git capture (outside SQLite; per A3 it happens first) ----
    const capture = captureWorkingTree(rootPath, taskId, sequence, actor);

    if (capture.degraded || !capture.result) {
      // Degraded: record a row with no git object, flagged in capture_status.
      return {
        id: uuid(),
        taskId,
        projectId: this.projectIdFor(taskId),
        sequence,
        kind,
        checkpointId: input.checkpointId ?? null,
        commitSha: null,
        refName,
        baseHeadSha: null,
        branchName: null,
        detachedHead: false,
        changedFiles: [],
        insertions: 0,
        deletions: 0,
        changedVsBaseline: [],
        insertionsVsBaseline: 0,
        deletionsVsBaseline: 0,
        captureStatus: 'degraded',
        captureReason: capture.reason ?? 'snapshot capture failed',
        excludedPaths: [],
        capturedAt: now,
        actor,
        targetSnapshotId: input.targetSnapshotId ?? null,
        safetySnapshotId: input.safetySnapshotId ?? null,
        eventType: 'snapshot_failed',
        eventPayload: { task_id: taskId, kind, capture_reason: capture.reason ?? 'snapshot capture failed' },
      };
    }

    const result = capture.result;

    // Summary vs previous snapshot of the same task.
    let changedFiles: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean; previousPath?: string }> = [];
    let insertions = 0;
    let deletions = 0;
    if (previousSnapshot && previousSnapshot.commit_sha) {
      const diff = diffRefs(rootPath, previousSnapshot.commit_sha, result.commitSha);
      changedFiles = diff.changedFiles;
      insertions = diff.insertions;
      deletions = diff.deletions;
    } else {
      // Baseline: no previous snapshot → everything in the tree is "added".
      changedFiles = listTreeFiles(rootPath, result.commitSha).map((p) => ({
        path: p,
        status: 'added',
        insertions: 0,
        deletions: 0,
        binary: isBinaryFile(rootPath, p),
      }));
      insertions = 0;
      deletions = 0;
    }

    // Summary vs the task's baseline snapshot.
    let changedVsBaseline: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean; previousPath?: string }> = [];
    let insertionsVsBaseline = 0;
    let deletionsVsBaseline = 0;
    if (baselineSnapshot && baselineSnapshot.commit_sha) {
      const diff = diffRefs(rootPath, baselineSnapshot.commit_sha, result.commitSha);
      changedVsBaseline = diff.changedFiles;
      insertionsVsBaseline = diff.insertions;
      deletionsVsBaseline = diff.deletions;
    }

    return {
      id: uuid(),
      taskId,
      projectId: this.projectIdFor(taskId),
      sequence,
      kind,
      checkpointId: input.checkpointId ?? null,
      commitSha: result.commitSha,
      refName: result.refName,
      baseHeadSha: result.baseHeadSha,
      branchName: result.branchName ?? null,
      detachedHead: result.detachedHead,
      changedFiles,
      insertions,
      deletions,
      changedVsBaseline,
      insertionsVsBaseline,
      deletionsVsBaseline,
      captureStatus: 'ok',
      captureReason: null,
      excludedPaths: capture.excludedPaths,
      capturedAt: now,
      actor,
      targetSnapshotId: input.targetSnapshotId ?? null,
      safetySnapshotId: input.safetySnapshotId ?? null,
      eventType: 'snapshot_captured',
      eventPayload: {
        snapshot_id: '', // filled after insert
        task_id: taskId,
        kind,
        commit_sha: result.commitSha,
        ref_name: result.refName,
        capture_status: 'ok',
        insertions,
        deletions,
      },
    };
  }

  /** Persist a pending capture: snapshot row + its event (one transaction). */
  recordCaptured(pending: PendingSnapshotCapture): TaskSnapshotRow {
    return this.insertRow(pending);
  }

  private insertRow(fields: PendingSnapshotCapture): TaskSnapshotRow {
    const { id, eventType, eventPayload, ...rest } = fields;
    this.db.raw
      .prepare(
        `INSERT INTO task_snapshots (id, task_id, project_id, sequence, kind, checkpoint_id, commit_sha, ref_name, base_head_sha, branch_name, detached_head, changed_files, insertions, deletions, changed_vs_baseline, insertions_vs_baseline, deletions_vs_baseline, capture_status, capture_reason, excluded_paths, captured_at, actor, target_snapshot_id, safety_snapshot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        rest.taskId,
        rest.projectId,
        rest.sequence,
        rest.kind,
        rest.checkpointId,
        rest.commitSha,
        rest.refName,
        rest.baseHeadSha,
        rest.branchName,
        rest.detachedHead ? 1 : 0,
        JSON.stringify(rest.changedFiles.map(({ previousPath, ...f }) => f)),
        rest.insertions,
        rest.deletions,
        JSON.stringify(rest.changedVsBaseline.map(({ previousPath, ...f }) => f)),
        rest.insertionsVsBaseline,
        rest.deletionsVsBaseline,
        rest.captureStatus,
        rest.captureReason,
        JSON.stringify(rest.excludedPaths),
        rest.capturedAt,
        rest.actor,
        rest.targetSnapshotId,
        rest.safetySnapshotId,
      );

    // Fill in the snapshot id for the event payload.
    const payload = { ...eventPayload, snapshot_id: id };

    this.events.recordEvent({
      projectId: rest.projectId,
      taskId: rest.taskId,
      actor: rest.actor,
      eventType,
      payload,
    });

    return this.getSnapshot(id)!;
  }
}

function toSnapshotRow(row: Record<string, any>): TaskSnapshotRow {
  return {
    id: row.id,
    task_id: row.task_id,
    project_id: row.project_id,
    sequence: row.sequence,
    kind: row.kind,
    checkpoint_id: row.checkpoint_id,
    commit_sha: row.commit_sha,
    ref_name: row.ref_name,
    base_head_sha: row.base_head_sha,
    branch_name: row.branch_name,
    detached_head: row.detached_head === 1,
    changed_files: parseJsonColumn<ChangedPath[]>(row.changed_files, []),
    insertions: row.insertions,
    deletions: row.deletions,
    changed_vs_baseline: parseJsonColumn<ChangedPath[]>(row.changed_vs_baseline, []),
    insertions_vs_baseline: row.insertions_vs_baseline,
    deletions_vs_baseline: row.deletions_vs_baseline,
    capture_status: row.capture_status,
    capture_reason: row.capture_reason,
    excluded_paths: parseJsonColumn<string[]>(row.excluded_paths, []),
    captured_at: row.captured_at,
    actor: row.actor,
    target_snapshot_id: row.target_snapshot_id ?? null,
    safety_snapshot_id: row.safety_snapshot_id ?? null,
  };
}

/** List every file in a git tree (baseline has no previous snapshot to diff against). */
function listTreeFiles(rootPath: string, commitSha: string): string[] {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', commitSha], {
      cwd: rootPath,
      encoding: 'utf8',
      shell: undefined,
    });
    return String(out).split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}
