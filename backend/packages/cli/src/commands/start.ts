import { loadConfig } from '@workjournal/core';
import { createDatabase, runMigrations, buildServer } from '@workjournal/core';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePidFile } from '../utils/pid-file.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startCommand() {
  const config = loadConfig();
  const homeDir = config.workjournalHome.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');

  const dbPath = resolve(homeDir, 'registry.db');
  const db = createDatabase(dbPath);

  const migrationsDir = resolve(__dirname, '../../../core/migrations');
  runMigrations(db, migrationsDir);

  const server = buildServer(db, config);

  writePidFile(homeDir);

  await server.listen({ host: config.host, port: config.port });
  console.log(`WorkJournal core service running at http://${config.host}:${config.port}`);

  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
}
