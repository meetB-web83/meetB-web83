-- 002_unified_events.sql — canonical event model (plan §3 / spec M3, WS-2)
--
-- Rebuilds `events` so that:
--   * task_id becomes NULLABLE — project-level agent lifecycle events have no
--     task (plan §3.1); they sequence per project (task_id IS NULL).
--   * event_id is the client-generated dedup key for idempotent ingestion
--     (decisions D-017/D-023); core-generated events leave it NULL and keep
--     using the internal `id`.
--   * occurred_at separates event occurrence from recording time (M3 §2);
--     existing rows backfill from created_at.
--   * category and source classify every event for the unified timeline
--     (D-017); existing rows keep category 'task', source 'core'.
--
-- SQLite cannot drop a NOT NULL constraint in place, hence the table rebuild.
-- Nothing references `events` in 001, so the drop/rename is safe; the
-- events -> tasks FK is carried over to the rebuilt table.

CREATE TABLE events_rebuilt (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  sequence INTEGER NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'task',
  source TEXT NOT NULL DEFAULT 'core',
  payload TEXT NOT NULL DEFAULT '{}',
  event_id TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO events_rebuilt (id, project_id, task_id, sequence, actor, event_type, category, source, payload, event_id, occurred_at, created_at)
  SELECT id, project_id, task_id, sequence, actor, event_type, 'task', 'core', payload, NULL, created_at, created_at
  FROM events;

DROP TABLE events;
ALTER TABLE events_rebuilt RENAME TO events;

-- Per-task timeline ordering (pre-002 name kept).
CREATE INDEX idx_events_task ON events(task_id, sequence);
-- Project-level (task-less) history lookup.
CREATE INDEX idx_events_project ON events(project_id);
-- Plan §3.1: supports both query shapes (task timeline and project history).
CREATE INDEX idx_events_project_task_seq ON events(project_id, task_id, sequence);
-- Plan §3.2: category-filtered per-task queries.
CREATE INDEX idx_events_task_category ON events(task_id, category, sequence);
-- Idempotent ingestion dedup (D-023): one row per client event_id.
CREATE UNIQUE INDEX idx_events_event_id ON events(event_id) WHERE event_id IS NOT NULL;
