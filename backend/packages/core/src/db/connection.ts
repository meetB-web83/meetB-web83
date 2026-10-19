import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * `node:sqlite` is experimental, so it is missing from `module.builtinModules` and Vite
 * (which runs the test suite) refuses to resolve it as a built-in if imported directly.
 * `process.getBuiltinModule` resolves it natively at runtime without any import graph
 * entry, so bundlers never see it — and unlike `createRequire(import.meta.url)` it also
 * works inside the CommonJS SEA bundle, where esbuild leaves `import.meta` empty (D-011).
 * Requires Node >= 22.3.0 (see engines).
 */
const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;
if (!sqliteModule) {
  throw new Error(
    'node:sqlite is unavailable — WorkJournal requires Node.js >= 22.3.0. Upgrade Node and retry.',
  );
}
const { DatabaseSync: DatabaseSyncCtor } = sqliteModule;

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
