-- 003_project_snapshots.sql — working-tree snapshots (Addendum A, M2)
-- Lives in <project-root>/.workjournal/workjournal.db.
-- One row per captured snapshot (baseline / checkpoint / safety), append-only.
-- Snapshot objects live in the repository's .git under refs/workjournal/<task-id>/<seq>;
-- this table stores only the SHA, ref name and stat summaries — never file contents or diffs.

CREATE TABLE IF NOT EXISTS task_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'checkpoint', 'safety')),
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
  actor TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_task_snapshots_task_seq ON task_snapshots(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_task_snapshots_task ON task_snapshots(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_task_snapshots_project ON task_snapshots(project_id);
