import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';

export const snapshotKindSchema = z.enum(['baseline', 'checkpoint', 'safety', 'rollback']);
export type SnapshotKind = z.infer<typeof snapshotKindSchema>;

/** Shape of one changed path in a snapshot change summary. */
export const changedPathSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'binary']),
  insertions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  /** Previous path when status is `renamed`. */
  previous_path: z.string().optional(),
  binary: z.boolean().default(false),
});

export const snapshotSummarySchema = z.object({
  changed_files: z.array(changedPathSchema),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

/** Canonical snapshot row as stored and returned by Core. */
export const taskSnapshotSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  project_id: z.string(),
  sequence: z.number().int(),
  kind: snapshotKindSchema,
  checkpoint_id: z.string().nullable(),
  commit_sha: z.string().nullable(),
  ref_name: z.string().nullable(),
  base_head_sha: z.string().nullable(),
  branch_name: z.string().nullable(),
  detached_head: z.boolean(),
  changed_files: z.array(changedPathSchema),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_vs_baseline: z.array(changedPathSchema),
  insertions_vs_baseline: z.number().int().nonnegative(),
  deletions_vs_baseline: z.number().int().nonnegative(),
  capture_status: z.enum(['ok', 'degraded']),
  capture_reason: z.string().nullable(),
  excluded_paths: z.array(z.string()),
  captured_at: z.string(),
  actor: z.string(),
  /** Rollback linkage — set on kind='rollback' snapshots (Addendum B). */
  target_snapshot_id: z.string().nullable().optional(),
  safety_snapshot_id: z.string().nullable().optional(),
});

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type ChangedPath = z.infer<typeof changedPathSchema>;
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

/** List snapshots for a task. `task_id` may be injected from the route path. */
export const listSnapshotsQuerySchema = z.object({
  task_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListSnapshotsQuery = z.infer<typeof listSnapshotsQuerySchema>;

/** ---- get_task_changes (A5) ---- */

export const taskChangesComparisonSchema = z.enum([
  'baseline_to_latest',
  'snapshot_to_snapshot',
  'vs_worktree',
  'vs_head',
]);

export const getTaskChangesQuerySchema = z.object({
  /** Injected from the route path (`/api/tasks/:id/changes`) when absent. */
  task_id: z.string().min(1).optional(),
  comparison: taskChangesComparisonSchema.default('baseline_to_latest'),
  from_snapshot_id: z.string().optional(),
  to_snapshot_id: z.string().optional(),
  /** Return per-file diffs (summary-only when omitted/false). */
  include_diff: z.preprocess(
    (value) => value === 'true' ? true : value === 'false' ? false : value,
    z.boolean().optional(),
  ),
  /** Return a full patch (size-capped). Implies include_diff. */
  include_patch: z.preprocess(
    (value) => value === 'true' ? true : value === 'false' ? false : value,
    z.boolean().optional(),
  ),
});

export type GetTaskChangesQuery = z.infer<typeof getTaskChangesQuerySchema>;

export const taskChangesResponseSchema = z.object({
  task_id: z.string(),
  comparison: taskChangesComparisonSchema,
  baseline_snapshot: taskSnapshotSchema.nullable(),
  latest_snapshot: taskSnapshotSchema.nullable(),
  from_snapshot: taskSnapshotSchema.nullable(),
  to_snapshot: taskSnapshotSchema.nullable(),
  changed_files: z.array(changedPathSchema),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Live, not stored: current working tree vs latest snapshot. */
  drift: z.object({
    changed_files: z.array(changedPathSchema),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    live: z.boolean().default(true),
  }).optional(),
  /** Diff output, secret-filtered; omitted unless requested. */
  diff: z.string().optional(),
  patch: z.string().optional(),
  patch_truncated: z.boolean().default(false),
  size_capped: z.boolean().default(false),
});

export type TaskChangesResponse = z.infer<typeof taskChangesResponseSchema>;

/** ---- preview_revert_task (A6, extended by Addendum B) ---- */

/**
 * Per-path plan status, precedence order evaluated against the target tree (T),
 * the effective snapshot tree (E) and the worktree (W) — spec §6.2:
 *
 *   not-restorable  target capture degraded — never restorable, never forceable
 *   clean           W equals T (already at target, no-op) or W equals E with T
 *                   present — safe write of the target bytes
 *   restore         W missing, T has the path — apply writes it back
 *   delete          T lacks the path, W exists and equals E — apply deletes it
 *   missing         W missing, T lacks the path — already in target state
 *   changed-since   W diverged from E, T has the path — skip unless forced
 *   conflict        W diverged from E, T lacks the path — skip unless forced
 *
 * Invariant: exactly one status per path; {clean, restore} end at the target's
 * content, {delete, missing} end absent, {changed-since, conflict} are skipped
 * unless force_paths opts in, not-restorable is never applied.
 */
export const revertPathStatusSchema = z.enum([
  'clean',
  'changed-since',
  'conflict',
  'missing',
  'restore',
  'delete',
  'not-restorable',
]);

export type RevertPathStatus = z.infer<typeof revertPathStatusSchema>;

/** Reference to a snapshot as used in preview/apply responses. */
export const revertSnapshotRefSchema = z.object({
  id: z.string(),
  kind: snapshotKindSchema,
  sequence: z.number().int().nonnegative(),
  commit_sha: z.string().nullable(),
  capture_status: z.enum(['ok', 'degraded']),
});

export const previewRevertTaskSchema = z.object({
  task_id: z.string().min(1),
  agent_id: z.string().min(1).max(200),
  /** Snapshot id, or `baseline` (default). */
  target: z.string().min(1).default('baseline'),
});

export type PreviewRevertTaskInput = z.infer<typeof previewRevertTaskSchema>;

export const previewRevertPathSchema = z.object({
  path: z.string(),
  status: revertPathStatusSchema,
  reason: z.string().optional(),
});

export const revertPlanSummarySchema = z.object({
  clean: z.number().int().nonnegative(),
  restore: z.number().int().nonnegative(),
  delete: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  'changed-since': z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  'not-restorable': z.number().int().nonnegative(),
});

export const previewRevertTaskResponseSchema = z.object({
  task_id: z.string(),
  target: revertSnapshotRefSchema,
  effective: revertSnapshotRefSchema,
  paths: z.array(previewRevertPathSchema),
  summary: revertPlanSummarySchema,
  /** Paths apply will write back from the target. */
  would_restore: z.array(z.string()),
  /** Paths apply will delete (absent from the target). */
  would_delete: z.array(z.string()),
  /** changed-since + conflict paths — must be listed in force_paths to apply. */
  skipped_by_default: z.array(z.string()),
  preview_id: z.string(),
});

export type PreviewRevertTaskResponse = z.infer<typeof previewRevertTaskResponseSchema>;

/** ---- revert_task_changes (A6, extended by Addendum B) ---- */

export const revertTaskChangesSchema = z.object({
  task_id: z.string().min(1),
  agent_id: z.string().min(1).max(200),
  /** Snapshot id, or `baseline` (default). Must match the preview's target. */
  target: z.string().min(1).default('baseline'),
  preview_id: z.string().min(1).describe('Reference to a preview_revert_task result'),
  reason: z.string().min(1).max(2000).describe('Why this rollback is happening (required)'),
  /** Explicit per-path opt-in for changed-since/conflict paths. */
  force_paths: z.array(z.string().min(1)).max(200).optional(),
  idempotency_key: idempotencyKeySchema,
});

export type RevertTaskChangesInput = z.infer<typeof revertTaskChangesSchema>;

export const revertTaskChangesResponseSchema = z.object({
  task_id: z.string(),
  target_snapshot_id: z.string(),
  target_kind: snapshotKindSchema,
  /** Snapshot the working tree was rolled back from. */
  effective_snapshot_id: z.string(),
  safety_snapshot_id: z.string(),
  safety_snapshot_sha: z.string(),
  rollback_snapshot_id: z.string(),
  rollback_snapshot_sha: z.string(),
  /** Paths now matching the target (writes + already-matching). */
  reverted_paths: z.array(z.string()),
  /** Paths absent per the target (deletes + already-absent). */
  deleted_paths: z.array(z.string()),
  skipped_paths: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** Partial application: paths that failed to apply (spec §7.4). */
  failed_paths: z.array(z.object({ path: z.string(), reason: z.string() })),
  rolled_back_checkpoint_ids: z.array(z.string()),
  applied_at: z.string(),
});

export type RevertTaskChangesResponse = z.infer<typeof revertTaskChangesResponseSchema>;
