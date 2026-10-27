import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDatabase, runMigrations, type Database, type MigrationFile } from '@workjournal/core';
import { PROJECT_MIGRATIONS_DIR } from '../helpers/registry-factory.js';

/**
 * WS-2.1: migration 002_unified_events + 002b_session_task_binding.
 * Real SQLite files: fresh-DB shape, plus the upgrade path from a 001-era
 * database with existing rows (data preserved, defaults applied).
 */
describe('Migration 002 — unified events', () => {
  let dir: string;
  let db: Database;

  const only = (name: string): MigrationFile[] => {
    const sql = readFileSync(resolve(PROJECT_MIGRATIONS_DIR, name), 'utf-8');
    return [{ name, sql }];
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workjournal-mig002-'));
  });

  afterEach(() => {
    try {
      db.raw.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh DB has the canonical events shape and the session binding table', () => {
    db = createDatabase(join(dir, 'fresh.db'));
    runMigrations(db, PROJECT_MIGRATIONS_DIR);

    const eventCols = Object.fromEntries(
      (db.raw.prepare('PRAGMA table_info(events)').all() as any[]).map((c) => [c.name, c]),
    );
    expect(eventCols.task_id.notnull).toBe(0); // nullable (plan §3.1)
    expect(eventCols.category).toBeDefined();
    expect(eventCols.source).toBeDefined();
    expect(eventCols.event_id).toBeDefined();
    expect(eventCols.occurred_at.notnull).toBe(1);

    const indexes = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all() as any[]).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_events_task',
        'idx_events_project',
        'idx_events_project_task_seq',
        'idx_events_task_category',
        'idx_events_event_id',
      ]),
    );

    const bindingCols = (db.raw.prepare('PRAGMA table_info(session_task_bindings)').all() as any[]).map((c) => c.name);
    expect(bindingCols).toEqual(['session_id', 'project_id', 'task_id', 'agent_id', 'created_at', 'released_at']);
  });

  it('upgrades a 001-era DB: rows preserved with task/default backfill', () => {
    db = createDatabase(join(dir, 'upgrade.db'));
    runMigrations(db, only('001_project_init.sql'));

    db.raw
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'P1', '/p1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'T1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO events (id, project_id, task_id, sequence, actor, event_type, payload, created_at)
         VALUES ('e1', 'p1', 't1', 1, 'op', 'task_created', '{"title":"T1"}', '2026-01-01T00:00:01.000Z')`,
      )
      .run();

    runMigrations(db, PROJECT_MIGRATIONS_DIR);

    const row = db.raw.prepare('SELECT * FROM events WHERE id = ?').get('e1') as any;
    expect(row.task_id).toBe('t1');
    expect(row.category).toBe('task');
    expect(row.source).toBe('core');
    expect(row.event_id).toBeNull();
    expect(row.occurred_at).toBe(row.created_at); // backfilled from created_at
    expect(row.payload).toBe('{"title":"T1"}'); // data intact through the rebuild
  });

  it('enforces one event_id per row (idempotent ingestion dedup)', () => {
    db = createDatabase(join(dir, 'dedup.db'));
    runMigrations(db, PROJECT_MIGRATIONS_DIR);
    db.raw
      .prepare(
        `INSERT INTO events (id, project_id, task_id, sequence, actor, event_type, category, source, payload, event_id, occurred_at, created_at)
         VALUES ('e1', 'p1', NULL, 1, 'a', 'agent_idle', 'agent', 'core', '{}', 'dup-key', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO events (id, project_id, task_id, sequence, actor, event_type, category, source, payload, event_id, occurred_at, created_at)
           VALUES ('e2', 'p1', NULL, 2, 'a', 'agent_idle', 'agent', 'core', '{}', 'dup-key', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('keeps only one ACTIVE session binding per session', () => {
    db = createDatabase(join(dir, 'binding.db'));
    runMigrations(db, PROJECT_MIGRATIONS_DIR);
    db.raw
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'P1', '/p1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'T1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO session_task_bindings (session_id, project_id, task_id, agent_id, created_at) VALUES ('s1', 'p1', 't1', 'a1', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO session_task_bindings (session_id, project_id, task_id, agent_id, created_at) VALUES ('s1', 'p1', 't1', 'a2', '2026-01-01T00:00:01.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });
});
