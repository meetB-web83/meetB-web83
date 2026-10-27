import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, runMigrations, type Database } from '@workjournal/core';
import { PROJECT_MIGRATIONS_DIR } from './registry-factory.js';

/**
 * A real project DB built from the REAL project migrations (not a hand-rolled
 * DDL copy — schema drift between migrations and tests is exactly the class of
 * bug this replaces). Callers insert their own `projects` row when they need
 * one (tasks.project_id has an FK).
 */
export function createTestDb(): { db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'workjournal-test-'));
  const db = createDatabase(join(dir, 'test.db'));
  runMigrations(db, PROJECT_MIGRATIONS_DIR);

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
