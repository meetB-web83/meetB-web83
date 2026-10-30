import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { getPinoConfig, LOG_FILE } from '@workjournal/shared';
import { createDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { registryMigrationsSource } from './db/migrations-source.js';
import { buildServer } from './http/server.js';

const config = loadConfig();

const homeDir = config.workjournalHome.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
mkdirSync(homeDir, { recursive: true });

const dbPath = resolve(homeDir, 'registry.db');
const db = createDatabase(dbPath);

runMigrations(db, registryMigrationsSource());

const server = buildServer(db, config, { logger: getPinoConfig() });

try {
  await server.listen({ host: config.host, port: config.port });
  server.log.info({ host: config.host, port: config.port, logFile: LOG_FILE }, 'WorkJournal core service started');
} catch (err) {
  server.log.error({ err }, 'Failed to start WorkJournal core service');
  process.exit(1);
}
