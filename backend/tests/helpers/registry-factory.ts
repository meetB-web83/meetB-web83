import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations, type Database } from '@workjournal/core';

// backend/tests/helpers/ → backend/packages/core/{migrations,project-migrations}
const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REGISTRY_MIGRATIONS_DIR = resolve(HERE, '../../packages/core/migrations');
export const PROJECT_MIGRATIONS_DIR = resolve(HERE, '../../packages/core/project-migrations');

/** A real registry DB (registry_projects, registry_idempotency) built from the real migrations. */
export function createRegistryDb(): { db: Database; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'workjournal-registry-'));
  const db = createDatabase(join(dir, 'registry.db'));
  runMigrations(db, REGISTRY_MIGRATIONS_DIR);

  return {
    db,
    dir,
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

/** Temp directory standing in for a project root. */
export function tempProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), 'workjournal-project-'));
}
