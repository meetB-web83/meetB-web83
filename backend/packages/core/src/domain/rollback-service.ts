import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { Database } from '../db/connection.js';
import { EventService } from './event-service.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { TaskService } from './task-service.js';
import {
  SnapshotService,
  type PendingSnapshotCapture,
  type TaskSnapshotRow,
} from './snapshot-service.js';
import { blobAt, diffPathSet, inspectRepo, lsTreeEntry, treeSha } from './git-snapshot.js';
import {
  NotFoundError,
  OPERATOR,
  OwnerMismatchError,
  ValidationError,
  type PreviewRevertTaskInput,
  type PreviewRevertTaskResponse,
  type RevertPathStatus,
  type RevertTaskChangesInput,
  type RevertTaskChangesResponse,
} from '@workjournal/shared';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

/** What apply does for one planned path (spec §6.2). */
type PlanAction = 'write' | 'delete' | 'noop' | 'none';

interface PlanEntry {
  path: string;
  status: RevertPathStatus;
  action: PlanAction;
  reason?: string;
  /** sha256 of the worktree state ('ABSENT'/'ERROR:…' markers for non-content). */
  wtHash: string;
}

interface RevertPlan {
  target: TaskSnapshotRow;
  effective: TaskSnapshotRow;
  entries: PlanEntry[];
  fingerprint: string;
}

interface PreparedRevert {
  taskId: string;
  projectId: string;
  agentId: string;
  target: TaskSnapshotRow;
  effective: TaskSnapshotRow;
  plan: RevertPlan;
}

const PREVIEW_ID_PREFIX = 'wjp1.';

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deterministic hash of one worktree path state. */
function worktreeStateHash(state: { kind: 'absent' } | { kind: 'bytes'; bytes: Buffer } | { kind: 'error'; reason: string }): string {
  if (state.kind === 'absent') return 'ABSENT';
  if (state.kind === 'error') return 'ERROR:' + createHash('sha256').update(state.reason).digest('hex');
  return createHash('sha256').update(state.bytes).digest('hex');
}

function readWorktree(rootPath: string, relPath: string): { kind: 'absent' } | { kind: 'bytes'; bytes: Buffer } | { kind: 'error'; reason: string } {
  try {
    return { kind: 'bytes', bytes: readFileSync(resolve(rootPath, relPath)) };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', reason: err?.message ?? String(err) };
  }
}

/**
 * Executable bit of a worktree file. On Windows the exec bit is not
 * representable (stat never reports it), so mode normalization there degrades
 * to content-only — apply still writes the correct bytes.
 */
function isExecutable(rootPath: string, relPath: string): boolean {
  try {
    return (statSync(resolve(rootPath, relPath)).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Client-supplied path guard (force_paths + defense-in-depth on plan paths):
 * relative, git-normalized, no traversal, no NUL, never inside .workjournal/.
 * Throws `path escapes the project root: <p>` on traversal/absolute input.
 */
export function validateRelativePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new ValidationError(`invalid path: ${JSON.stringify(p)}`);
  }
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm)) {
    throw new ValidationError(`path escapes the project root: ${p}`);
  }
  if (norm.split('/').includes('..')) {
    throw new ValidationError(`path escapes the project root: ${p}`);
  }
  if (norm === '.workjournal' || norm.startsWith('.workjournal/')) {
    throw new ValidationError(`path is inside the protected .workjournal directory: ${p}`);
  }
  return norm;
}

/**
 * Containment check: the resolved path must stay inside the project root, and
 * any existing ancestor (symlinks resolved) must also live inside the root —
 * a symlinked parent cannot smuggle writes outside the project.
 */
export function assertPathInsideRoot(rootPath: string, relPath: string): void {
  const norm = validateRelativePath(relPath);
  const rootResolved = resolve(rootPath);
  const abs = resolve(rootResolved, norm);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new ValidationError(`path escapes the project root: ${relPath}`);
  }
  // Resolve the deepest existing ancestor through symlinks.
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const realRoot = realpathSync(rootResolved);
    const realProbe = realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
      throw new ValidationError(`path escapes the project root: ${relPath}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // realpath failure on an existing-but-inaccessible path: deny by default.
    throw new ValidationError(`path escapes the project root: ${relPath}`);
  }
}

/**
 * Unified revert/rollback engine (Addendum A §A6, Addendum B §B2–B5).
 *
 * One engine serves both whole-task revert (target = baseline) and
 * rollback-to-checkpoint (target = any checkpoint/safety snapshot of the task):
 *
 *   preview — read-only plan (statuses, fingerprint); no state change, no event.
 *   apply   — two-phase mutation inside ONE idempotency transaction:
 *             safety snapshot → filesystem plan → post-rollback snapshot →
 *             revert_applied event. Rejected applies record nothing (except the
 *             mid-apply crash audit, see `revert_rejected` in the spec).
 *
 * Everything is synchronous so it can run inside `IdempotencyService.run`:
 * a duplicate key replays the stored response WITHOUT invoking the callback,
 * which is what makes retries safe even though the working tree has changed.
 */
export class RollbackService {
  private events: EventService;
  private tasks: TaskService;
  private idem: IdempotencyService;
  private snapshots: SnapshotService;

  constructor(private db: Database) {
    this.events = new EventService(db);
    this.tasks = new TaskService(db);
    this.idem = new IdempotencyService(db);
    this.snapshots = new SnapshotService(db);
  }

  /** Owner-or-operator authorization (B: applies to preview and apply). */
  private assertAuthorized(owner: string | null, agentId: string): void {
    if (agentId === OPERATOR) return;
    if (owner && owner === agentId) return;
    throw new OwnerMismatchError(
      owner
        ? `Task is owned by ${owner}; only the current owner or operator can revert it.`
        : 'Task is unclaimed; claim it before reverting, or use the operator actor.',
    );
  }

  /** Resolve `baseline` or a snapshot id to a target snapshot (spec §6.1). */
  private resolveTarget(taskId: string, targetStr: string): TaskSnapshotRow {
    let snap: TaskSnapshotRow | null;
    if (targetStr === 'baseline') {
      snap = this.snapshots.getBaselineSnapshot(taskId);
      if (!snap) {
        throw new NotFoundError('baseline snapshot not found for this task — claim the task first');
      }
    } else {
      snap = this.snapshots.getSnapshot(targetStr);
      if (!snap) throw new NotFoundError(`target snapshot not found: ${targetStr}`);
      if (snap.task_id !== taskId) {
        throw new ValidationError('target snapshot belongs to a different task');
      }
    }
    if (snap.kind === 'rollback') {
      throw new ValidationError(
        'invalid target: rollback snapshots cannot be targeted; use a checkpoint, the baseline, or a safety snapshot',
      );
    }
    return snap;
  }

  /** No-op rejection: target already describes the current state (spec §6.1). */
  private assertNotCurrent(rootPath: string, target: TaskSnapshotRow, effective: TaskSnapshotRow): void {
    if (target.id === effective.id) {
      throw new ValidationError('target is the current state, nothing to roll back');
    }
    if (!target.commit_sha || !effective.commit_sha) return; // degraded side: checked by the plan
    const tt = treeSha(rootPath, target.commit_sha);
    const et = treeSha(rootPath, effective.commit_sha);
    if (tt && et && tt === et) {
      throw new ValidationError('target is the current state, nothing to roll back');
    }
  }

  /**
   * Shared validation + plan construction for preview and apply (spec §6.2/§7.2).
   * Read-only: any failure throws an actionable error and records nothing.
   */
  private prepare(taskId: string, agentId: string, targetStr: string, rootPath: string): PreparedRevert {
    const task = this.tasks.getTask(taskId);
    this.assertAuthorized(task.owner, agentId);

    const repo = inspectRepo(rootPath);
    if (!repo.isRepo) {
      throw new ValidationError(`revert is unavailable: ${rootPath} is not a git repository`);
    }

    const effective = this.snapshots.getEffectiveSnapshot(taskId);
    if (!effective) throw new NotFoundError('no snapshots exist for this task — claim it first');
    const target = this.resolveTarget(taskId, targetStr);
    this.assertNotCurrent(rootPath, target, effective);

    const plan = this.buildPlan(rootPath, target, effective);
    return { taskId, projectId: task.project_id, agentId, target, effective, plan };
  }

  /** Build the path set + per-path statuses + worktree fingerprint (spec §6.2). */
  private buildPlan(rootPath: string, target: TaskSnapshotRow, effective: TaskSnapshotRow): RevertPlan {
    // ---- Degraded target: everything changed since it is reported, not restorable.
    if (target.capture_status !== 'ok' || !target.commit_sha) {
      const union = new Set<string>();
      for (const s of this.snapshots.allSnapshots(target.task_id)) {
        if (s.sequence > target.sequence && s.capture_status === 'ok') {
          for (const f of s.changed_files) union.add(f.path);
        }
      }
      const entries: PlanEntry[] = [...union].sort().map((path) => {
        assertPathInsideRoot(rootPath, path);
        return {
          path,
          status: 'not-restorable' as const,
          action: 'none' as const,
          reason: 'target snapshot has no git object (capture failed)',
          wtHash: worktreeStateHash(readWorktree(rootPath, path)),
        };
      });
      return { target, effective, entries, fingerprint: fingerprintOf(entries) };
    }

    if (effective.capture_status !== 'ok' || !effective.commit_sha) {
      throw new ValidationError(
        'effective snapshot unavailable (capture failed); cannot compute rollback plan',
      );
    }

    const pathSet = diffPathSet(rootPath, target.commit_sha, effective.commit_sha);
    const entries: PlanEntry[] = pathSet.map((ps) => {
      assertPathInsideRoot(rootPath, ps.path);
      return this.statusFor(rootPath, target, effective, ps);
    });
    return { target, effective, entries, fingerprint: fingerprintOf(entries) };
  }

  /** Compare target tree (T), effective tree (E) and worktree (W) — spec §6.2. */
  private statusFor(
    rootPath: string,
    target: TaskSnapshotRow,
    effective: TaskSnapshotRow,
    ps: { path: string; inTarget: boolean; inEffective: boolean },
  ): PlanEntry {
    const { path } = ps;
    const tSha = target.commit_sha!;
    const eSha = effective.commit_sha!;
    const w = readWorktree(rootPath, path);
    const wtHash = worktreeStateHash(w);

    const notRestorable = (reason: string): PlanEntry => ({
      path,
      status: 'not-restorable',
      action: 'none',
      reason,
      wtHash,
    });

    // Target-side entry defense: symlinks/gitlinks and unaddressable blobs
    // cannot be restored byte-for-byte — report instead of corrupting.
    const targetEntry = ps.inTarget ? lsTreeEntry(rootPath, tSha, path) : null;
    if (ps.inTarget && !targetEntry) return notRestorable('target entry missing');
    if (targetEntry && targetEntry.mode !== '100644' && targetEntry.mode !== '100755') {
      return notRestorable(`unsupported entry mode ${targetEntry.mode}`);
    }

    if (w.kind === 'absent') {
      if (ps.inTarget) {
        if (!blobAt(rootPath, tSha, path)) return notRestorable('target blob unavailable');
        return { path, status: 'restore', action: 'write', reason: 'deleted in the worktree; will be restored', wtHash };
      }
      return { path, status: 'missing', action: 'noop', reason: 'already absent per the target', wtHash };
    }

    if (w.kind === 'error') {
      // Unreadable (directory in place of a file, permissions): treat as
      // diverged so a default apply never clobbers it.
      return ps.inTarget
        ? { path, status: 'changed-since', action: 'write', reason: `worktree path unreadable: ${w.reason}`, wtHash }
        : { path, status: 'conflict', action: 'delete', reason: `worktree path unreadable: ${w.reason}`, wtHash };
    }

    if (ps.inTarget) {
      const tBytes = blobAt(rootPath, tSha, path);
      if (!tBytes) return notRestorable('target blob unavailable');
      if (w.bytes.equals(tBytes)) {
        // Content matches, but a mode-only difference still needs the write
        // path so apply chmods the file back to the target's recorded mode
        // (spec §6.2 case 2 — "already at target" includes the mode).
        if (targetEntry && isExecutable(rootPath, path) !== (targetEntry.mode === '100755')) {
          return {
            path,
            status: 'clean',
            action: 'write',
            reason: 'content matches the target; file mode will be restored',
            wtHash,
          };
        }
        return { path, status: 'clean', action: 'noop', reason: 'already matches the target', wtHash };
      }
      if (ps.inEffective) {
        const eBytes = blobAt(rootPath, eSha, path);
        if (eBytes && w.bytes.equals(eBytes)) {
          return { path, status: 'clean', action: 'write', reason: 'will be restored to the target content', wtHash };
        }
      }
      return { path, status: 'changed-since', action: 'write', reason: 'worktree changed since the effective snapshot', wtHash };
    }

    // Not in target (added after the target): E has it by construction.
    const eBytes = blobAt(rootPath, eSha, path);
    if (eBytes && w.bytes.equals(eBytes)) {
      return { path, status: 'delete', action: 'delete', reason: 'added after the target; will be deleted', wtHash };
    }
    return { path, status: 'conflict', action: 'delete', reason: 'worktree diverged and the target has no copy', wtHash };
  }

  /**
   * Stateless preview (read-only): no idempotency key, no events, no snapshot,
   * no filesystem writes. The returned preview_id embeds task + resolved target
   * + effective snapshot + worktree fingerprint; apply re-derives and compares.
   */
  preview(input: PreviewRevertTaskInput, rootPath: string): PreviewRevertTaskResponse {
    const { target, effective, plan } = this.prepare(input.task_id, input.agent_id, input.target, rootPath);

    const summary = { clean: 0, restore: 0, delete: 0, missing: 0, 'changed-since': 0, conflict: 0, 'not-restorable': 0 };
    for (const e of plan.entries) summary[e.status] += 1;

    return {
      task_id: input.task_id,
      target: snapshotRef(target),
      effective: snapshotRef(effective),
      paths: plan.entries.map((e) => ({ path: e.path, status: e.status, reason: e.reason })),
      summary,
      would_restore: plan.entries.filter((e) => e.status === 'restore').map((e) => e.path),
      would_delete: plan.entries.filter((e) => e.status === 'delete').map((e) => e.path),
      skipped_by_default: plan.entries
        .filter((e) => e.status === 'changed-since' || e.status === 'conflict')
        .map((e) => e.path),
      preview_id: encodePreviewId(input.task_id, target.id, effective.id, plan.fingerprint),
    };
  }

  /**
   * Apply the plan (spec §7.3). All mutation happens inside the idempotency
   * transaction; validation failures roll back with nothing recorded, an
   * equivalent retry replays the stored response without re-validating.
   */
  apply(
    input: RevertTaskChangesInput,
    rootPath: string,
    idempotency: MutationIdempotency,
  ): RevertTaskChangesResponse {
    const options: IdempotencyOptions = {
      key: idempotency.key,
      operation: 'revert_task_changes',
      actor: input.agent_id,
      input: idempotency.input,
    };

    let fsStarted = false;
    let safetyRef: string | null = null;

    try {
      return this.idem.run('idempotency_records', options, () => {
        // ---- Validation on FRESH state (replays never reach here) ----
        const prepared = this.prepare(input.task_id, input.agent_id, input.target, rootPath);
        const { target, effective, plan, projectId } = prepared;

        this.verifyPreviewId(input.preview_id, prepared, plan.fingerprint);
        const forceSet = new Set<string>();
        for (const p of input.force_paths ?? []) {
          assertPathInsideRoot(rootPath, p); // traversal / .workjournal rejection
          forceSet.add(p);
        }
        // A degraded target has no git object: nothing can be restored from it,
        // even when the union of later changes happens to be empty (spec §7.2).
        if (target.capture_status !== 'ok' || !target.commit_sha) {
          throw new ValidationError(
            'target snapshot was captured degraded and cannot be restored; nothing to apply',
          );
        }
        if (plan.entries.length > 0 && plan.entries.every((e) => e.status === 'not-restorable')) {
          throw new ValidationError('target snapshot was captured degraded and cannot be restored; nothing to apply');
        }

        const baseline = this.snapshots.getBaselineSnapshot(input.task_id);

        // ---- 1. Safety snapshot FIRST (git + row + event, same tx) ----
        const safety = this.snapshots.captureOnly({
          taskId: input.task_id,
          actor: input.agent_id,
          kind: 'safety',
          rootPath,
          previousSnapshot: effective,
          baselineSnapshot: baseline,
        });
        if (safety.captureStatus === 'degraded') {
          throw new ValidationError(
            `safety snapshot capture failed: ${safety.captureReason ?? 'unknown error'}; nothing was changed`,
          );
        }
        safetyRef = safety.refName;
        this.snapshots.recordCaptured(safety);

        // ---- 2. Filesystem plan ----
        fsStarted = true;
        const applied = applyPlan(rootPath, plan, forceSet);

        // ---- 3. Post-rollback snapshot, linked to target + safety ----
        const rollbackPending = this.snapshots.captureOnly({
          taskId: input.task_id,
          actor: input.agent_id,
          kind: 'rollback',
          rootPath,
          previousSnapshot: effective,
          baselineSnapshot: baseline,
          targetSnapshotId: target.id,
          safetySnapshotId: safety.id,
        });
        this.snapshots.recordCaptured(rollbackPending);

        // ---- 4. Rolled-back checkpoints derived from the committed rows ----
        // Checkpoint ids (checkpoints.id), matching the RollbackInfo derivation
        // so response, resume, exports and dashboard all speak checkpoint ids.
        const rolledBackCheckpointIds = this.snapshots
          .allSnapshots(input.task_id)
          .filter(
            (s) =>
              s.kind === 'checkpoint' &&
              s.checkpoint_id &&
              s.sequence > target.sequence &&
              s.sequence < safety.sequence,
          )
          .map((s) => s.checkpoint_id as string);

        // ---- 5. revert_applied event (reason required by B5) ----
        const appliedAt = new Date().toISOString();
        this.events.recordEvent({
          projectId,
          taskId: input.task_id,
          actor: input.agent_id,
          eventType: 'revert_applied',
          payload: {
            task_id: input.task_id,
            preview_id: input.preview_id,
            target_snapshot_id: target.id,
            target_kind: target.kind,
            effective_snapshot_id: effective.id,
            reason: input.reason,
            safety_snapshot_id: safety.id,
            rollback_snapshot_id: rollbackPending.id,
            reverted_path_count: applied.reverted.length,
            deleted_path_count: applied.deleted.length,
            skipped_path_count: applied.skipped.length,
            failed_path_count: applied.failed.length,
            ...(applied.failed.length ? { failed_paths: applied.failed.slice(0, 200) } : {}),
          },
        });

        return {
          task_id: input.task_id,
          target_snapshot_id: target.id,
          target_kind: target.kind,
          effective_snapshot_id: effective.id,
          safety_snapshot_id: safety.id,
          safety_snapshot_sha: safety.commitSha ?? '',
          rollback_snapshot_id: rollbackPending.id,
          rollback_snapshot_sha: rollbackPending.commitSha ?? '',
          reverted_paths: applied.reverted,
          deleted_paths: applied.deleted,
          skipped_paths: applied.skipped,
          failed_paths: applied.failed,
          rolled_back_checkpoint_ids: rolledBackCheckpointIds,
          applied_at: appliedAt,
        };
      });
    } catch (err) {
      // Mid-apply crash: the transaction rolled back (no snapshot rows, no
      // revert_applied, no idempotency record) but files may have changed.
      // The one allowed event for a rejected operation: a recovery audit that
      // survives the rollback and points at the safety snapshot ref (spec §7.5).
      if (fsStarted) {
        try {
          const task = this.tasks.getTask(input.task_id);
          this.events.recordEvent({
            projectId: task.project_id,
            taskId: input.task_id,
            actor: input.agent_id,
            eventType: 'revert_rejected',
            payload: {
              task_id: input.task_id,
              reason: `rollback failed mid-apply: ${reasonOf(err).slice(0, 1500)}${
                safetyRef ? `; safety snapshot ref: ${safetyRef}` : ''
              }`.slice(0, 2000),
            },
          });
        } catch {
          // The audit write must never mask the original failure.
        }
      }
      throw err;
    }
  }

  /** Preview freshness + binding checks (spec §7.2 step 5). */
  private verifyPreviewId(previewId: string, prepared: PreparedRevert, fingerprint: string): void {
    const decoded = decodePreviewId(previewId);
    if (!decoded) {
      throw new ValidationError('invalid preview_id — run preview_revert_task and pass its preview_id');
    }
    if (decoded.t !== prepared.taskId) {
      throw new ValidationError('preview does not match this task — run preview_revert_task again');
    }
    if (decoded.k !== prepared.target.id) {
      throw new ValidationError(
        'preview does not match the specified target — preview again with this target',
      );
    }
    if (decoded.e !== prepared.effective.id || decoded.f !== fingerprint) {
      throw new ValidationError('preview expired: working tree changed, preview again');
    }
  }
}

/* ---------- plan helpers ---------- */

function fingerprintOf(entries: PlanEntry[]): string {
  const rows = entries
    .map((e) => [e.path, e.wtHash] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function encodePreviewId(taskId: string, targetId: string, effectiveId: string, fingerprint: string): string {
  const payload = JSON.stringify({ v: 1, t: taskId, k: targetId, e: effectiveId, f: fingerprint });
  return PREVIEW_ID_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

function decodePreviewId(raw: string): { t: string; k: string; e: string; f: string } | null {
  if (typeof raw !== 'string' || !raw.startsWith(PREVIEW_ID_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw.slice(PREVIEW_ID_PREFIX.length), 'base64url').toString('utf8'));
    if (
      typeof parsed?.t !== 'string' ||
      typeof parsed?.k !== 'string' ||
      typeof parsed?.e !== 'string' ||
      typeof parsed?.f !== 'string'
    ) {
      return null;
    }
    return { t: parsed.t, k: parsed.k, e: parsed.e, f: parsed.f };
  } catch {
    return null;
  }
}

function snapshotRef(s: TaskSnapshotRow) {
  return {
    id: s.id,
    kind: s.kind,
    sequence: s.sequence,
    commit_sha: s.commit_sha,
    capture_status: s.capture_status,
  };
}

/** Execute the plan against the filesystem; partial failures are collected. */
function applyPlan(
  rootPath: string,
  plan: RevertPlan,
  forceSet: Set<string>,
): {
  reverted: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; reason: string }>;
} {
  const reverted: string[] = [];
  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];

  for (const e of plan.entries) {
    if (e.status === 'not-restorable') {
      skipped.push({ path: e.path, reason: e.reason ?? 'not restorable' });
      continue;
    }
    if ((e.status === 'changed-since' || e.status === 'conflict') && !forceSet.has(e.path)) {
      skipped.push({
        path: e.path,
        reason: `${e.reason ?? e.status} — skipped; list it in force_paths to apply`,
      });
      continue;
    }
    if (e.action === 'noop') {
      if (e.status === 'missing') deleted.push(e.path);
      else reverted.push(e.path);
      continue;
    }
    try {
      const abs = resolve(rootPath, e.path);
      if (e.action === 'delete') {
        rmSync(abs, { force: true }); // non-recursive: a directory fails → failed_paths
        deleted.push(e.path);
      } else {
        const tSha = plan.target.commit_sha!;
        const bytes = blobAt(rootPath, tSha, e.path);
        if (!bytes) throw new Error('target blob unavailable');
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
        const entry = lsTreeEntry(rootPath, tSha, e.path);
        if (entry?.mode === '100755') chmodSync(abs, 0o755);
        else if (entry?.mode === '100644') chmodSync(abs, 0o644);
        reverted.push(e.path);
      }
    } catch (err) {
      failed.push({ path: e.path, reason: reasonOf(err) });
    }
  }

  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    reverted: reverted.sort(),
    deleted: deleted.sort(),
    skipped: skipped.sort(byPath),
    failed: failed.sort(byPath),
  };
}

/** Kept for callers that only need the resolved path (route validation). */
export function validateForcePaths(rootPath: string, paths: string[] | undefined): void {
  for (const p of paths ?? []) assertPathInsideRoot(rootPath, p);
}
