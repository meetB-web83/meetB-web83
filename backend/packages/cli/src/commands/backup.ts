import { loadConfig, createDatabase, createBackup } from '@workjournal/core';
import { resolve } from 'node:path';

export async function backupCommand() {
  const config = loadConfig();
  const dbPath = resolve(config.workjournalHome, 'registry.db');
  const db = createDatabase(dbPath);

  const backupDir = resolve(config.workjournalHome, 'backups');
  const backupPath = createBackup(db, backupDir);

  console.log(`Backup created: ${backupPath}`);
}
