import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '@workjournal/core';

export function createTestDb(): { db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'workjournal-test-'));
  const db = createDatabase(join(dir, 'test.db'));

  db.raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      objective TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      owner TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      latest_checkpoint_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      sequence INTEGER NOT NULL,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      task_version INTEGER NOT NULL,
      progress_summary TEXT NOT NULL,
      completed_work TEXT,
      current_findings TEXT,
      unresolved_issues TEXT,
      next_steps TEXT,
      file_references TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      statement TEXT NOT NULL,
      rationale TEXT,
      alternatives TEXT NOT NULL DEFAULT '[]',
      supporting_event_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE idempotency_records (
      key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      actor TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_tasks_project ON tasks(project_id);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_events_task ON events(task_id, sequence);
    CREATE INDEX idx_checkpoints_task ON checkpoints(task_id);
    CREATE INDEX idx_decisions_task ON decisions(task_id);
  `);

  return {
    db,
    cleanup: () => {
      try {
        db.raw.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
