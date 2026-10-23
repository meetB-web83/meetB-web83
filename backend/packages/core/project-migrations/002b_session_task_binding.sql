-- 002b_session_task_binding.sql session-to-task binding table (plan 10.4, D-023)
-- Additive migration: adds a new table for persisting session->task bindings.
-- One active binding per session; bindings survive Core restart.
BEGIN;

CREATE TABLE session_task_bindings (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  bound_at TEXT NOT NULL,
  UNIQUE(session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_task_bindings_task_id ON session_task_bindings(task_id);

COMMIT;
