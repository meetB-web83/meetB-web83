// Library entry point for @workjournal/core.
// The runnable service bootstrap lives in ./main.ts.
export { loadConfig, type Config } from './config.js';
export { createDatabase, type Database } from './db/connection.js';
export { createBackup } from './db/backup.js';
export { runMigrations, ensureMigrationsDir } from './db/migrate.js';
export { ProjectDbResolver, normalizeRootPath, projectDbPath, type ProjectScope } from './db/project-db.js';
export { buildServer } from './http/server.js';
export { buildServices, type CoreServices } from './http/services.js';
export { TaskService, type CreateTaskData, type TaskUpdateData } from './domain/task-service.js';
export { DashboardService } from './domain/dashboard-service.js';
export { ProjectService } from './domain/project-service.js';
export { CheckpointService } from './domain/checkpoint-service.js';
export { DecisionService } from './domain/decision-service.js';
export { EventService, type RecordEventInput } from './domain/event-service.js';
export {
  IdempotencyService,
  type IdempotencyOptions,
  type IdempotencyTable,
} from './domain/idempotency-service.js';
export { canTransition, allowedTransitions } from './domain/transitions.js';
export { ResumeBuilder } from './resume/resume-builder.js';
export { JsonExporter } from './export/json-export.js';
export { MarkdownExporter } from './export/markdown-export.js';
export { filterSecrets, filterSecretsDeep } from './export/secret-filter.js';
