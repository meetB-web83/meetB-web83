-- 002_unified_events.sql — canonical event envelope (plan §3)
-- events.task_id is NOT NULL in 001_project_init.sql, so project-level agent
-- lifecycle events (session start with no task context, project summary refresh)
-- cannot be recorded. SQLite does not support ALTER COLUMN ... DROP NOT NULL in
-- the bundled SQLite, so we rebuild the table in place, preserving every existing
-- row. Existing rows default to category = 'task', source = 'core'.
--
-- Additive semantics: no column or table is dropped permanently; the rebuild only
-- changes task_id nullability and adds category/source + two indexes.
BEGIN;

CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  sequence INTEGER NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  category TEXT NOT NULL DEFAULT 'task',
  source TEXT NOT NULL DEFAULT 'core',
  created_at TEXT NOT NULL
);

INSERT INTO events_new (
  id, project_id, task_id, sequence, actor, event_type, payload, category, source, created_at
)
SELECT id, project_id, task_id, sequence, actor, event_type, payload, 'task', 'core', created_at
FROM events;

DROP TABLE events;

ALTER TABLE events_new RENAME TO events;

CREATE INDEX IF NOT EXISTS idx_events_project_task_seq ON events(project_id, task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_task_category_seq ON events(task_id, category, sequence);

COMMIT;
