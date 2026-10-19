import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * `node:sqlite` is experimental, so it is missing from `module.builtinModules` and Vite
 * (which runs the test suite) refuses to resolve it as a built-in. Requiring it through
 * `createRequire` keeps the import invisible to bundlers while Node resolves it natively;
 * the type-only import above is erased at compile time.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export interface Database {
  raw: DatabaseSync;
  path: string;
}

export function createDatabase(dbPath: string): Database {
  mkdirSync(resolve(dbPath, '..'), { recursive: true });

  const raw = new DatabaseSyncCtor(dbPath);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  return { raw, path: dbPath };
}
