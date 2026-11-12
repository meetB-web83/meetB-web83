-- 004_rollback_snapshots.sql — rollback to a checkpoint (Addendum B, M2)
-- Lives in <project-root>/.workjournal/workjournal.db.
--
-- Extends task_snapshots for the unified revert/rollback engine:
--   * kind gains 'rollback' (the post-rollback working-tree snapshot).
--   * target_snapshot_id / safety_snapshot_id link a rollback snapshot to the
--     snapshot it restored and the safety snapshot captured before the apply.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Existing rows
-- are copied with NULLs for the new columns; no existing data changes. The linkage
-- columns are plain TEXT (no self-FK): the referenced snapshot always already exists,
-- and avoiding a self-reference keeps the rebuild free of FK ordering concerns.
-- Append-only: this migration never updates or deletes snapshot rows.

CREATE TABLE task_snapshots_v2 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'checkpoint', 'safety', 'rollback')),
  checkpoint_id TEXT REFERENCES checkpoints(id),
  commit_sha TEXT,
  ref_name TEXT,
  base_head_sha TEXT,
  branch_name TEXT,
  detached_head INTEGER NOT NULL DEFAULT 0,
  changed_files TEXT NOT NULL DEFAULT '[]',
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changed_vs_baseline TEXT NOT NULL DEFAULT '[]',
  insertions_vs_baseline INTEGER NOT NULL DEFAULT 0,
  deletions_vs_baseline INTEGER NOT NULL DEFAULT 0,
  capture_status TEXT NOT NULL DEFAULT 'ok',
  capture_reason TEXT,
  excluded_paths TEXT NOT NULL DEFAULT '[]',
  captured_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  target_snapshot_id TEXT,
  safety_snapshot_id TEXT
);

INSERT INTO task_snapshots_v2 (
  id, task_id, project_id, sequence, kind, checkpoint_id, commit_sha, ref_name,
  base_head_sha, branch_name, detached_head, changed_files, insertions, deletions,
  changed_vs_baseline, insertions_vs_baseline, deletions_vs_baseline,
  capture_status, capture_reason, excluded_paths, captured_at, actor
)
SELECT
  id, task_id, project_id, sequence, kind, checkpoint_id, commit_sha, ref_name,
  base_head_sha, branch_name, detached_head, changed_files, insertions, deletions,
  changed_vs_baseline, insertions_vs_baseline, deletions_vs_baseline,
  capture_status, capture_reason, excluded_paths, captured_at, actor
FROM task_snapshots;

DROP TABLE task_snapshots;

ALTER TABLE task_snapshots_v2 RENAME TO task_snapshots;

CREATE UNIQUE INDEX IF NOT EXISTS ux_task_snapshots_task_seq ON task_snapshots(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_task_snapshots_task ON task_snapshots(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_task_snapshots_project ON task_snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_task_snapshots_checkpoint ON task_snapshots(checkpoint_id);
