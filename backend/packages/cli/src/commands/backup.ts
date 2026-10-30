import { loadConfig, createDatabase, createBackup } from '@workjournal/core';
import { resolve } from 'node:path';
import { createLogger } from '@workjournal/shared';

const backupLogger = createLogger({ component: 'cli', command: 'backup' });

export async function backupCommand() {
  const config = loadConfig();
  const dbPath = resolve(config.workjournalHome, 'registry.db');

  backupLogger.info({ dbPath, home: config.workjournalHome }, 'backup command invoked');

  const db = createDatabase(dbPath);
  const backupDir = resolve(config.workjournalHome, 'backups');
  const backupPath = createBackup(db, backupDir);

  backupLogger.info({ backupPath, backupDir }, 'backup created successfully');
  console.log(`Backup created: ${backupPath}`);
}
