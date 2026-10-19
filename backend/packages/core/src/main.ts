import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './http/server.js';

const config = loadConfig();

const homeDir = config.workjournalHome.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
mkdirSync(homeDir, { recursive: true });

const dbPath = resolve(homeDir, 'registry.db');
const db = createDatabase(dbPath);

const migrationsDir = resolve(import.meta.dirname, '../migrations');
runMigrations(db, migrationsDir);

const server = buildServer(db, config);

try {
  await server.listen({ host: config.host, port: config.port });
  console.log(`WorkJournal core service running at http://${config.host}:${config.port}`);
} catch (err) {
  console.error('Failed to start WorkJournal core service:', err);
  process.exit(1);
}

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});
