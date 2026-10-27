// Library entry point for @workjournal/core.
// The runnable service bootstrap lives in ./main.ts.
export { loadConfig, type Config } from './config.js';
export { createDatabase, type Database } from './db/connection.js';
export { createBackup } from './db/backup.js';
export { runMigrations, ensureMigrationsDir, type MigrationFile } from './db/migrate.js';
export {
  registryMigrationsSource,
  projectMigrationsSource,
} from './db/migrations-source.js';
export { ProjectDbResolver, normalizeRootPath, projectDbPath, type ProjectScope } from './db/project-db.js';
export { buildServer, type BuildServerOptions } from './http/server.js';
export {
  loadUiAssetsFromDir,
  embeddedUiAssets,
  uiAssetsFromFiles,
  type UiAssets,
  type UiAsset,
} from './ui/ui-assets.js';
export { contentTypeFor } from './ui/content-type.js';
export { buildServices, type CoreServices } from './http/services.js';
export { TaskService, type CreateTaskData, type TaskUpdateData } from './domain/task-service.js';
export { DashboardService } from './domain/dashboard-service.js';
export { ProjectService } from './domain/project-service.js';
export { CheckpointService } from './domain/checkpoint-service.js';
export { DecisionService } from './domain/decision-service.js';
export { EventService, type RecordEventInput, type AppendEventInput, type AppendedEvent } from './domain/event-service.js';
export { IngestService } from './domain/ingest-service.js';
export { SessionBindingService } from './domain/session-binding-service.js';
export {
  IdempotencyService,
  type IdempotencyOptions,
  type IdempotencyTable,
} from './domain/idempotency-service.js';
export { canTransition, allowedTransitions } from './domain/transitions.js';
export {
  loadAutoStopConfig,
  startIdleSweeper,
  type AutoStopConfig,
  type IdleSweeper,
  type IdleSweeperOptions,
} from './runtime/idle-sweeper.js';
export { ResumeBuilder } from './resume/resume-builder.js';
export { JsonExporter } from './export/json-export.js';
export { MarkdownExporter } from './export/markdown-export.js';
export { filterSecrets, filterSecretsDeep } from './export/secret-filter.js';
