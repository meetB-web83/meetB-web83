import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from './connection.js';

export function createBackup(db: Database, backupDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(backupDir, `backup-${timestamp}.db`);
  copyFileSync(db.path, backupPath);
  return backupPath;
}
