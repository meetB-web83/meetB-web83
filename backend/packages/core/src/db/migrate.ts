import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from './connection.js';

/**
 * One SQL migration as an in-memory entry — the form the single-file SEA
 * executable uses (no .sql files exist next to the binary; see D-011).
 * `name` matches the on-disk file name so the `__migrations` ledger is
 * identical whichever source applied it.
 */
export interface MigrationFile {
  name: string;
  sql: string;
}

/**
 * Applies pending SQL migrations to a database, each inside its own transaction with its
 * own pre-migration backup (`<db>.<migration file>.bak`).
 *
 * Used twice: for the registry DB (`migrations/`) and lazily for every project DB
 * (`project-migrations/`).
 *
 * `source` is either a directory on disk (dev, Docker — reads `.sql` files) or an
 * embedded array (SEA executable). Disk content and embedded content are generated
 * from the same files, so both forms produce the same ledger.
 */
export function runMigrations(db: Database, source: string | MigrationFile[]): void {
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

  let files: string[];
  let sqlOf: (name: string) => string;
  if (typeof source === 'string') {
    files = readdirSync(source)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    sqlOf = (name) => readFileSync(resolve(source, name), 'utf-8');
  } else {
    const byName = new Map(source.map((f) => [f.name, f.sql]));
    files = [...byName.keys()].sort();
    sqlOf = (name) => {
      const sql = byName.get(name);
      if (sql === undefined) throw new Error(`Embedded migration ${name} has no SQL content.`);
      return sql;
    };
  }

  for (const file of files) {
    if (applied.has(file)) continue;

    const backupPath = `${db.path}.${file}.bak`;
    if (!existsSync(backupPath)) {
      copyFileSync(db.path, backupPath);
    }

    const statements = sqlOf(file);

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
