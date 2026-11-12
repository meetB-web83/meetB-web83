import { z } from 'zod';

/** Checkpoint detail — shared by `checkpoint` (working) and `checkpoints[]`. */
const checkpointFields = {
  id: z.string(),
  progress_summary: z.string(),
  completed_work: z.string().nullable(),
  current_findings: z.string().nullable(),
  unresolved_issues: z.string().nullable(),
  next_steps: z.string().nullable(),
  file_references: z.array(z.string()),
  created_at: z.string(),
};

export const handoffCheckpointSchema = z.object(checkpointFields);

/**
 * One `revert_applied` event as exported (Addendum B §B8): what was restored,
 * when, by whom and why — never raw diff content.
 */
export const handoffRollbackSchema = z.object({
  target_snapshot_id: z.string(),
  safety_snapshot_id: z.string(),
  rollback_snapshot_id: z.string(),
  reason: z.string(),
  actor: z.string(),
  /** Event recording time (UTC). */
  at: z.string(),
  rolled_back_checkpoint_ids: z.array(z.string()),
});

/**
 * JSON handoff contract, format v2 (Addendum B §B11/B8):
 *  - `checkpoint` is the WORKING (non-rolled-back) checkpoint,
 *  - `checkpoints[]` lists every checkpoint with its derived rolled-back flag,
 *  - `rollback` exposes the rollback history (event order, oldest first),
 *  - `snapshots` pins baseline/effective snapshot ids for change-set context.
 */
export const handoffJsonSchema = z.object({
  format_version: z.literal(2),
  exported_at: z.string(),
  task: z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    objective: z.string().nullable(),
    acceptance_criteria: z.array(z.string()),
    status: z.string(),
    priority: z.string(),
    owner: z.string().nullable(),
  }),
  checkpoint: handoffCheckpointSchema.nullable(),
  checkpoints: z.array(
    handoffCheckpointSchema.extend({
      rolled_back: z.boolean(),
      /** Present only when rolled_back — which rollback covered it. */
      rolled_back_by: z
        .object({
          rollback_event_id: z.string(),
          reason: z.string(),
          actor: z.string(),
          at: z.string(),
        })
        .optional(),
    }),
  ),
  rollback: z.object({
    present: z.boolean(),
    latest: handoffRollbackSchema.nullable(),
    rollbacks: z.array(handoffRollbackSchema),
  }),
  snapshots: z.object({
    baseline_id: z.string().nullable(),
    effective_id: z.string().nullable(),
    effective_sequence: z.number().int().nullable(),
    effective_kind: z.string().nullable(),
  }),
  decisions: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      rationale: z.string().nullable(),
      status: z.string(),
      superseded_by: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().int(),
      actor: z.string(),
      event_type: z.string(),
      payload: z.record(z.unknown()),
      created_at: z.string(),
    }),
  ),
});

export type HandoffJson = z.infer<typeof handoffJsonSchema>;
