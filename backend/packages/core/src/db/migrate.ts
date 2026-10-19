import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from './connection.js';

/**
 * Applies pending SQL migrations to a database, each inside its own transaction with its
 * own pre-migration backup (`<db>.<migration file>.bak`).
 *
 * Used twice: for the registry DB (`migrations/`) and lazily for every project DB
 * (`project-migrations/`).
 */
export function runMigrations(db: Database, migrationsDir: string): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.raw.prepare('SELECT name FROM __migrations').all().map((r: any) => r.name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const backupPath = `${db.path}.${file}.bak`;
    if (!existsSync(backupPath)) {
      copyFileSync(db.path, backupPath);
    }

    const sql = resolve(migrationsDir, file);
    const statements = readFileSync(sql, 'utf-8');

    db.raw.exec('BEGIN');
    try {
      db.raw.exec(statements);
      db.raw.prepare('INSERT INTO __migrations (name) VALUES (?)').run(file);
      db.raw.exec('COMMIT');
    } catch (err) {
      db.raw.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Ensure a migrations directory exists (used for per-project databases). */
export function ensureMigrationsDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
