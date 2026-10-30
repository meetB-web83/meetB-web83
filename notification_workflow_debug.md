# Notification Workflow Debug

## 1. Scenario

When a user creates a prompt via the MCP adapter (e.g., Opencode), Core creates the prompt in SQLite and publishes a `prompt:create` event to an in-memory `ChangeBus`. The MCP adapter subscribes to Core's SSE change stream (`/changes/stream`) and re-syncs its prompt registry whenever a change notification arrives. It then sends an MCP `prompts/list_changed` notification to connected clients.

Problems observed:

1. **Prompt create/delete errors are not logged in development.** `backend/logs/workjournal.log` was 0 bytes. Fastify's error handler only logged non-`WorkJournalError` errors. Since `ValidationError`, `IdempotencyConflictError`, `NotFoundError`, etc. all extend `WorkJournalError`, they were silently returned to the client without being written to the log file.

2. **No log output on individual prompt create/delete.** `PromptService.publish()` published to the `ChangeBus` silently — there was no pino log line when a prompt was created, deleted, updated, or toggled.

3. **Newly created prompt is not accessible in Opencode.** When a prompt is deleted and recreated with the same name, the new prompt has a different Core `id` but the same `name`. `syncPrompts` tracked only a `Set<string>` of registered names, so it skipped the re-created prompt (name already "registered"). The MCP server still held the old (deleted) prompt `id`. When Opencode executed the prompt, the callback fetched the old deleted `id` from Core → 404 → `Prompt "X" is no longer available.`

## 2. End Goal

- Every prompt create/update/delete/toggle produces a pino `info` log line in `workjournal.log` with `action`, `promptId`, `projectId`.
- Fastify error handler logs `WorkJournalError` subclasses (4xx at `warn`, 5xx at `error`) so errors appear in the log file.
- MCP adapter logs each SSE change-stream event at `debug` level.
- `syncPrompts` correctly handles prompt deletion + re-creation with the same name by tracking name → Core promptId mapping, removing stale registrations via `registeredPrompt.remove()`, and re-registering with the new Core `id`.
- Opencode can execute newly created prompts without seeing "Prompt X is no longer available."

## 3. Tools Being Used

| Tool | Purpose |
|------|---------|
| Core service (`@workjournal/core`) | Fastify HTTP service, all business logic, SQLite access (only process that opens SQLite) |
| MCP adapter (`@workjournal/mcp-adapter`) | Thin stdio MCP server that forwards to Core over loopback HTTP |
| `@workjournal/shared` | Zod schemas, error classes, pino logger — single source of truth |
| Fastify | HTTP server framework for Core |
| Pino | Structured JSON logging to `workjournal.log` |
| SQLite (better-sqlite3) | Per-project DB + registry DB |
| SSE (`/changes/stream`) | Core → MCP adapter prompt change notifications |
| MCP SDK (`@modelcontextprotocol/sdk`) | `McpServer`, `registerPrompt`, `sendPromptListChanged`, `StdioServerTransport` |
| Opencode | MCP client that calls prompt tools over stdio |
| tsx | Dev runtime (no build step for source) |
| tsc | Build to `dist/` for SEA packaging |

## 4. Build Process of Node SEA

- `pnpm build:exe` runs `tsx scripts/build-exe.ts` which uses `postject` to embed Node resources into the `workjournal` SEA executable.
- `pnpm build` runs `pnpm -r build`: each package runs its own `build` script.
  - Core: `tsx scripts/embed-ui.ts && tsx scripts/embed-migrations.ts && tsc` → outputs to `backend/packages/core/dist/`
  - MCP adapter: `tsc` → outputs to `backend/packages/mcp-adapter/dist/`
- The SEA executable (`workjournal(.exe)`) re-spawns itself for autostart; dev runs use `tsx watch src/main.ts` (Core) and `tsx src/index.ts` (MCP adapter).
- Logs: Core writes via Fastify `getPinoConfig()` → `pino.destination(LOG_FILE)`; MCP adapter and CLI write via `createLogger()` → same `LOG_FILE`.
- Default log dir: development walks up from `packages/shared/src/logger.ts` to find `.git`/`AGENTS.md`, then writes `<repo-root>/logs/workjournal.log`.

## 5. Opencode Prompt Issue

Opencode connects to the MCP adapter over stdio. The MCP server registers prompts as MCP prompt templates via `server.registerPrompt(name, config, callback)`. The callback re-fetches the prompt template from Core by `promptId` at execution time.

Bug flow:
1. User creates prompt "test" → Core assigns `id=A`, name="test". MCP registers name="test" → callback closure captures `id=A`.
2. User deletes prompt "test" → Core deletes row `id=A`. MCP change stream fires `prompt:delete`. Old `syncPrompts` skipped re-sync because name "test" already in `registeredNames` set. MCP server still holds name="test" → callback closure with `id=A`.
3. User creates prompt "test" again → Core assigns `id=B`, name="test". MCP change stream fires `prompt:create`. Old `syncPrompts` still skips because name "test" already registered.
4. Opencode executes prompt "test" → callback fetches Core `/api/prompts/A` → 404 (row deleted) → `Prompt "test" is no longer available.`

Fix: `syncPrompts` now tracks `Map<string, {promptId, registered}>`. On re-sync:
- Same name + same `id` → skip.
- Same name + different `id` → call `existing.registered.remove()`, delete from map, re-register with new `id`.
- Name in map but not in Core response → `registered.remove()`, delete from map (deleted prompt).

## 6. Things We Tried

| Attempt | Result |
|---------|--------|
| Added `promptServiceLogger.info()` in `PromptService.publish()` | Logs create/update/delete/toggle actions. |
| Fixed Fastify error handler to log `WorkJournalError` subclasses | Errors now appear in `workjournal.log` (4xx warn, 5xx error). |
| Added `mcpLogger.debug()` in `subscribeToPromptChanges()` for each SSE event | Logs each change-stream event received. |
| Rewrote `registry.ts` `syncPrompts` to use `Map<string, {promptId, registered}>` instead of `Set<string>` | Correctly removes stale registrations and re-registers when Core `id` changes for same name. |
| Built both packages with `tsc` | Typecheck and build pass cleanly. |

---

# Reference Section

## backend/packages/core/src/domain/change-bus.ts

```javascript
export interface PromptChangeEvent {
  type: 'prompt';
  action: 'create' | 'update' | 'delete' | 'toggle';
  promptId: string;
  projectId: string | null;
  timestamp: string;
}

type ChangeHandler = (event: PromptChangeEvent) => void;

/**
 * In-memory pub/sub for prompt change events.
 * Core service publishes mutations; the MCP adapter subscribes via SSE.
 */
export class ChangeBus {
  private handlers = new Map<string, ChangeHandler>();
  private counter = 0;

  subscribe(handler: ChangeHandler): string {
    const id = String(++this.counter);
    this.handlers.set(id, handler);
    return id;
  }

  unsubscribe(id: string): void {
    this.handlers.delete(id);
  }

  publish(event: PromptChangeEvent): void {
    for (const handler of this.handlers.values()) {
      try {
        handler(event);
      } catch {
        // Handler errors must not break other subscribers
      }
    }
  }

  handlerCount(): number {
    return this.handlers.size;
  }
}
```

## backend/packages/core/src/http/server.ts

```javascript
import Fastify from 'fastify';
import type { Database } from '../db/connection.js';
import type { Config } from '../config.js';
import { ProjectDbResolver } from '../db/project-db.js';
import { buildServices, type CoreServices } from './services.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerEventRoutes } from './routes/events.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerCheckpointRoutes } from './routes/checkpoints.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerResumeRoutes } from './routes/resume.js';
import { registerExportRoutes } from './routes/export.js';
import { registerPromptRoutes } from './routes/prompts.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerChangesRoutes } from './routes/changes.js';
import { registerUiRoutes } from './ui.js';
import { validateProjectsMount } from '../db/paths.js';
import { projectMigrationsSource } from '../db/migrations-source.js';
import type { UiAssets } from '../ui/ui-assets.js';
import { ChangeBus } from '../domain/change-bus.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Registry DB (project index + project-level idempotency). */
    registryDb: Database;
    /** Opens per-project databases on demand. */
    projectDbs: ProjectDbResolver;
    /** Registry-scoped services; task-scoped routes use `buildServices(projectDb)`. */
    services: CoreServices;
    config: Config;
  }
}

export interface BuildServerOptions {
  /** When provided, the dashboard is served from these in-memory assets on the
   * same origin as the API (`--with-ui` / SEA executable). Omitted → API-only. */
  ui?: UiAssets | null;
  /** Pino logger configuration object for Fastify's `logger` option. */
  logger?: Record<string, unknown>;
}

export function buildServer(
  db: Database,
  config: Config,
  options: BuildServerOptions = {},
) {
  const mountError = validateProjectsMount();
  if (mountError) throw new Error(mountError);

  const server = Fastify({
    logger: options.logger,
    bodyLimit: 1_048_576,
  });

  const projectDbs = new ProjectDbResolver(db, projectMigrationsSource());

  // Shared change bus for prompt mutation notifications (SSE → MCP adapter).
  const changeBus = new ChangeBus();

  server.decorate('registryDb', db);
  server.decorate('projectDbs', projectDbs);
  server.decorate('services', buildServices(db, config.pathContext, changeBus));
  server.decorate('config', config);

  server.addHook('onClose', async () => {
    projectDbs.closeAll();
  });

  server.setErrorHandler((error: any, request, reply) => {
    if (error?.name === 'WorkJournalError') {
      // Log expected business-logic errors (validation, idempotency, not-found, etc.)
      // so they appear in the log file instead of being silently returned to the client.
      const log = error.statusCode >= 500 ? request.log.error.bind(request.log) : request.log.warn.bind(request.log);
      log(
        { err: error, code: error.code, statusCode: error.statusCode },
        error.message,
      );
      return reply
        .status(error.statusCode || 400)
        .send({ error: error.code, message: error.message });
    }
    request.log.error(error);
    return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'An internal error occurred' });
  });

  server.register(registerProjectRoutes, { prefix: '/api/projects' });
  server.register(registerTaskRoutes, { prefix: '/api/tasks' });
  server.register(registerEventRoutes, { prefix: '/api/events' });
  server.register(registerIngestRoutes, { prefix: '/api/ingest' });
  server.register(registerCheckpointRoutes, { prefix: '/api/checkpoints' });
  server.register(registerDecisionRoutes, { prefix: '/api/decisions' });
  server.register(registerResumeRoutes, { prefix: '/api/resume' });
  server.register(registerExportRoutes, { prefix: '/api/export' });
  server.register(registerPromptRoutes, { prefix: '/api/prompts' });
  server.register(registerDashboardRoutes, { prefix: '/api/dashboard' });

  // SSE stream of prompt changes for the MCP adapter.
  registerChangesRoutes(server, server.services, changeBus);

  // Liveness probe for container health checks: no DB access, no auth.
  server.get('/health', async () => ({ status: 'ok' }));

  if (options.ui) registerUiRoutes(server, options.ui);

  return server;
}
```

## backend/packages/core/src/domain/prompt-service.ts

```javascript
import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { ChangeBus, type PromptChangeEvent } from './change-bus.js';
import { createLogger } from '@workjournal/shared';
import { NotFoundError, BuiltinPromptProtectedError } from '@workjournal/shared';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreatePromptData {
  name: string;
  description?: string;
  category?: string;
  template: string;
  args?: any[];
  projectId?: string | null;
  idempotency?: MutationIdempotency;
}

export interface UpdatePromptData {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  template?: string;
  args?: any[];
  enabled?: boolean;
  idempotency?: MutationIdempotency;
}

const promptServiceLogger = createLogger({ component: 'core', module: 'prompt-service' });

export class PromptService {
  private idem: IdempotencyService;
  constructor(private db: Database, private changeBus?: ChangeBus) {
    this.idem = new IdempotencyService(db);
  }

  private publish(action: PromptChangeEvent['action'], promptId: string, projectId: string | null): void {
    promptServiceLogger.info(
      { component: 'core', module: 'prompt-service', action, promptId, projectId },
      `prompt ${action}`,
    );
    if (this.changeBus) {
      this.changeBus.publish({
        type: 'prompt',
        action,
        promptId,
        projectId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private rowToPrompt(row: any) {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      category: row.category,
      template: row.template,
      arguments: JSON.parse(row.arguments || '[]'),
      project_id: row.project_id ?? null,
      is_builtin: !!row.is_builtin,
      enabled: !!row.enabled,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  list(opts: { scope?: 'global' | 'project'; projectId?: string; category?: string; enabled?: boolean; includeBuiltin?: boolean; resolved?: boolean }) {
    if (opts.resolved && opts.projectId) {
      const rows = this.db.raw.prepare('SELECT * FROM prompts WHERE project_id = ? OR project_id IS NULL').all(opts.projectId) as any[];
      const byName = new Map<string, any>();
      for (const r of rows) {
        if (opts.category && r.category !== opts.category) continue;
        if (opts.enabled !== undefined && !!r.enabled !== opts.enabled) continue;
        const existing = byName.get(r.name);
        if (!existing) byName.set(r.name, r);
        else if (r.project_id && !existing.project_id) byName.set(r.name, r);
      }
      const result: any[] = [];
      for (const [, r] of byName) {
        if (!r.enabled) continue;
        result.push(this.rowToPrompt(r));
      }
      return result;
    }
    let sql = 'SELECT * FROM prompts WHERE 1=1';
    const params: any[] = [];
    if (opts.scope === 'global') { sql += ' AND project_id IS NULL'; }
    if (opts.scope === 'project' && opts.projectId) { sql += ' AND project_id = ?'; params.push(opts.projectId); }
    if (opts.category) { sql += ' AND category = ?'; params.push(opts.category); }
    if (opts.enabled !== undefined) { sql += ' AND enabled = ?'; params.push(opts.enabled ? 1 : 0); }
    if (opts.includeBuiltin === false) { sql += ' AND is_builtin = 0'; }
    sql += ' ORDER BY name ASC, created_at ASC';
    return (this.db.raw.prepare(sql).all(...params) as any[]).map((r) => this.rowToPrompt(r));
  }

  get(id: string) {
    const row = this.db.raw.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as any;
    if (!row) throw new NotFoundError(`Prompt ${id} not found`);
    return this.rowToPrompt(row);
  }

  async toggle(id: string, enabled: boolean, idempotency?: MutationIdempotency) {
    return this.update({ id, enabled, idempotency });
  }

  async create(data: CreatePromptData) {
    return this.idem.run(
      'registry_idempotency' as any,
      data.idempotency && { ...data.idempotency, operation: 'prompt.create', actor: 'operator' },
      () => {
        const id = uuid();
        const now = new Date().toISOString();
        const category = data.category || 'custom';
        this.db.raw.prepare(
          `INSERT INTO prompts (id, name, description, category, template, arguments, project_id, is_builtin, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        ).run(id, data.name, data.description ?? null, category, data.template, JSON.stringify(data.args || []), data.projectId ?? null, now, now);
        this.publish('create', id, data.projectId ?? null);
        return this.get(id);
      },
    );
  }

  async update(data: UpdatePromptData) {
    return this.idem.run(
      'registry_idempotency' as any,
      data.idempotency && { ...data.idempotency, operation: 'prompt.update', actor: 'operator' },
      () => {
        const existing = this.get(data.id);
        const now = new Date().toISOString();
        const fields: string[] = [];
        const params: any[] = [];
        if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
        if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
        if (data.category !== undefined) { fields.push('category = ?'); params.push(data.category); }
        if (data.template !== undefined) { fields.push('template = ?'); params.push(data.template); }
        if (data.args !== undefined) { fields.push('arguments = ?'); params.push(JSON.stringify(data.args)); }
        if (data.enabled !== undefined) { fields.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
        fields.push('updated_at = ?');
        params.push(now);
        params.push(data.id);
        this.db.raw.prepare(`UPDATE prompts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        const updated = this.get(data.id);
        this.publish('update', data.id, updated.project_id ?? null);
        return updated;
      },
    );
  }

  async remove(id: string) {
    const p = this.get(id);
    if (p.is_builtin) throw new BuiltinPromptProtectedError(`Prompt ${id} is built-in and cannot be deleted`);
    this.db.raw.prepare('DELETE FROM prompts WHERE id = ?').run(id);
    this.publish('delete', id, p.project_id ?? null);
  }

  preview(id: string, args: Record<string, any> = {}) {
    const p = this.get(id);
    let out = p.template;
    for (const [k, v] of Object.entries(args)) {
      out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
    }
    return { rendered: out };
  }
}
```


All files that play a role in the prompt notification flow, from server connection to package.json. Nothing that is not part of this process is left out.


## backend/packages/core/src/http/services.ts

```javascript
import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { ProjectService } from '../domain/project-service.js';
import { CheckpointService } from '../domain/checkpoint-service.js';
import { PromptService } from '../domain/prompt-service.js';
import { ChangeBus } from '../domain/change-bus.js';
import { DecisionService } from '../domain/decision-service.js';
import { EventService } from '../domain/event-service.js';
import { ResumeBuilder } from '../resume/resume-builder.js';
import { JsonExporter } from '../export/json-export.js';
import { MarkdownExporter } from '../export/markdown-export.js';
import type { Services } from '../domain/services.js';
import type { PathContext } from '../db/paths.js';

export type CoreServices = Services;

/**
 * Build a service bundle bound to one database (the registry, or one project DB).
 * @param changeBus - optional shared change bus for prompt mutation notifications
 */
export function buildServices(
  db: Database,
  pathContext: PathContext | null = null,
  changeBus?: ChangeBus,
): Services {
  return {
    tasks: new TaskService(db),
    projects: new ProjectService(db, pathContext),
    checkpoints: new CheckpointService(db),
    decisions: new DecisionService(db),
    events: new EventService(db),
    resume: new ResumeBuilder(db),
    jsonExport: new JsonExporter(db),
    prompts: new PromptService(db, changeBus),
    markdownExport: new MarkdownExporter(db),
  };
}
```

## backend/packages/core/src/http/hooks/validation.ts

```javascript
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ZodSchema } from 'zod';
import { ValidationError } from '@workjournal/shared';

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      (request as any).body = schema.parse(request.body);
    } catch (err: any) {
      throw new ValidationError(err.message || 'Validation failed');
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      (request as any).query = schema.parse(request.query);
    } catch (err: any) {
      throw new ValidationError(err.message || 'Validation failed');
    }
  };
}

/**
 * The validated input minus the idempotency key: exactly what gets hashed and compared
 * when an idempotency key is replayed (root AGENTS.md: hash excludes the key).
 */
export function operationInput<T extends Record<string, any>>(input: T): Omit<T, 'idempotency_key'> {
  const { idempotency_key: _key, ...rest } = input;
  return rest;
}
```

## backend/packages/core/src/domain/idempotency-service.ts

```javascript
import { createHash } from 'node:crypto';
import type { Database } from '../db/connection.js';
import { IdempotencyConflictError } from '@workjournal/shared';

/** Where a given operation records its idempotency rows. */
export type IdempotencyTable = 'idempotency_records' | 'registry_idempotency';

/** Idempotency context supplied by the HTTP layer (validated input, without the key). */
export interface IdempotencyOptions {
  key: string;
  operation: string;
  actor: string;
  input: unknown;
}

/** Deterministic JSON: object keys sorted at every depth. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * Every state-changing operation runs through `run()`:
 *
 *   BEGIN IMMEDIATE → idempotency check → state change → event → idempotency record → COMMIT
 *
 * A duplicate key with the same operation, actor and input hash replays the stored
 * response without touching state; anything else raises IDEMPOTENCY_KEY_CONFLICT. Any
 * error rolls the whole thing back, so a rejected call leaves no state change, no event
 * and no idempotency record (root AGENTS.md: idempotency).
 */
export class IdempotencyService {
  constructor(private db: Database) {}

  hashInput(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalize(input)) ?? 'null').digest('hex');
  }

  /** Run `fn` atomically, with idempotency enforcement when `options` is provided. */
  run<T>(table: IdempotencyTable, options: IdempotencyOptions | undefined, fn: () => T): T {
    const selectSql =
      table === 'idempotency_records'
        ? 'SELECT * FROM idempotency_records WHERE key = ?'
        : 'SELECT * FROM registry_idempotency WHERE key = ?';
    const insertSql =
      table === 'idempotency_records'
        ? 'INSERT INTO idempotency_records (key, operation, actor, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO registry_idempotency (key, operation, actor, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)';

    this.db.raw.exec('BEGIN IMMEDIATE');
    try {
      if (options) {
        const inputHash = this.hashInput(options.input);
        const existing = this.db.raw.prepare(selectSql).get(options.key) as any;

        if (existing) {
          this.db.raw.exec('ROLLBACK');
          if (
            existing.operation === options.operation &&
            existing.actor === options.actor &&
            existing.input_hash === inputHash
          ) {
            return JSON.parse(existing.response);
          }
          throw new IdempotencyConflictError(
            `Idempotency key "${options.key}" was already used with different input, actor or operation. Use a new key for a new operation.`,
          );
        }

        const result = fn();
        this.db.raw
          .prepare(insertSql)
          .run(
            options.key,
            options.operation,
            options.actor,
            inputHash,
            JSON.stringify(result ?? null),
            new Date().toISOString(),
          );
        this.db.raw.exec('COMMIT');
        return result;
      }

      const result = fn();
      this.db.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // Transaction already rolled back (duplicate-key replay path).
      }
      throw err;
    }
  }
}
```

## backend/packages/core/src/config.ts

```javascript
import type { PathContext } from './db/paths.js';
import { loadPathContext } from './db/paths.js';

export interface Config {
  workjournalHome: string;
  host: string;
  port: number;
  logLevel: string;
  nodeEnv: string;
  /**
   * Host↔container project-path mapping. Null in native development
   * (PROJECTS_DIRECTORY unset): paths are used exactly as given.
   */
  pathContext: PathContext | null;
}

export function loadConfig(): Config {
  return {
    workjournalHome: process.env.WORKJOURNAL_HOME || '~/.workjournal',
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT || '3737', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development',
    pathContext: loadPathContext(),
  };
}
```

## backend/packages/core/src/main.ts

```javascript
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { getPinoConfig } from '@workjournal/shared';
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
  server.log.info({ host: config.host, port: config.port }, 'WorkJournal core service started');
} catch (err) {
  server.log.error({ err }, 'Failed to start WorkJournal core service');
  process.exit(1);
}
```

## backend/packages/shared/src/logger.ts

```javascript
import pino from 'pino';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Determine the log directory.
 * Priority:
 *  1. WORKJOURNAL_LOG_DIR env var (explicit override)
 *  2. Running as the SEA executable → sibling `logs/` folder next to the exe
 *  3. Development → repo root `logs/` folder (walk up from here to find .git/AGENTS.md)
 */
export function getLogDir(): string {
  const override = process.env.WORKJOURNAL_LOG_DIR;
  if (override) return override;

  const exeBase = basename(process.execPath);
  if (/^workjournal(\.exe)?$/i.test(exeBase)) {
    return join(dirname(process.execPath), 'logs');
  }

  // Development: walk up from this file's location to find the repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  const fsRoot = dirname(dir);
  while (dir !== fsRoot) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'AGENTS.md'))) {
      return join(dir, 'logs');
    }
    dir = dirname(dir);
  }
  return join(process.cwd(), 'logs');
}

/** The log file path — one file, appended to, never rotated in Release 1. */
export const LOG_FILE = join(getLogDir(), 'workjournal.log');

/**
 * Ensure the log directory exists before the first write.
 * Safe to call multiple times.
 */
export function ensureLogDir(): void {
  mkdirSync(getLogDir(), { recursive: true });
}

/**
 * Pino logger configuration object for Fastify's `logger` option.
 * Fastify supports the `file` option which internally uses `pino.destination()`
 * to write JSON lines to `LOG_FILE`.
 *
 * Database queries are intentionally NOT logged — this logger is for service
 * lifecycle, prompt notifications, MCP sync, and actionable errors only.
 */
export function getPinoConfig(): Record<string, unknown> {
  ensureLogDir();
  return {
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    // `file` is a Fastify-specific option (not in pino's type) that tells
    // Fastify to use `pino.destination()` to write to this file.
    file: LOG_FILE,
  };
}

/**
 * Create a standalone pino logger (for MCP adapter and CLI, which are not
 * Fastify instances). Writes to the same `LOG_FILE` as Fastify so all
 * components share one log file.
 */
export function createLogger(bindings?: Record<string, unknown>): pino.Logger {
  ensureLogDir();

  const base = pino(
    {
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: LOG_FILE, mkdir: true }),
  );

  return bindings ? base.child(bindings) : base;
}

/** A default logger with no bindings, for use outside request context. */
export const logger = createLogger();

/** Create a child logger with stable context fields (e.g. prompt name, action). */
export function child(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
```

## backend/packages/shared/src/errors.ts

```javascript
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'STALE_VERSION'
  | 'UNAUTHORIZED'
  | 'INVALID_TRANSITION'
  | 'OWNER_MISMATCH'
  | 'TASK_CLAIMED'
  | 'TASK_NOT_CLAIMED'
  | 'BUILTIN_PROMPT_PROTECTED'
  | 'INTERNAL_ERROR';

export class WorkJournalError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'WorkJournalError';
  }
}

export class ValidationError extends WorkJournalError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 400);
  }
}

export class NotFoundError extends WorkJournalError {
  constructor(message: string) {
    super('NOT_FOUND', message, 404);
  }
}

export class IdempotencyConflictError extends WorkJournalError {
  constructor(message: string) {
    super('IDEMPOTENCY_KEY_CONFLICT', message, 409);
  }
}

export class StaleVersionError extends WorkJournalError {
  constructor(message: string) {
    super('STALE_VERSION', message, 409);
  }
}

export class UnauthorizedError extends WorkJournalError {
  constructor(message: string) {
    super('UNAUTHORIZED', message, 403);
  }
}

export class InvalidTransitionError extends WorkJournalError {
  constructor(message: string) {
    super('INVALID_TRANSITION', message, 422);
  }
}

export class OwnerMismatchError extends WorkJournalError {
  constructor(message: string) {
    super('OWNER_MISMATCH', message, 403);
  }
}

export class TaskClaimedError extends WorkJournalError {
  constructor(message: string) {
    super('TASK_CLAIMED', message, 409);
  }
}

export class TaskNotClaimedError extends WorkJournalError {
  constructor(message: string) {
    super('TASK_NOT_CLAIMED', message, 409);
  }
}

export class BuiltinPromptProtectedError extends WorkJournalError {
  constructor(message: string) {
    super('BUILTIN_PROMPT_PROTECTED', message, 400);
  }
}

export class InternalError extends WorkJournalError {
  constructor(message: string) {
    super('INTERNAL_ERROR', message, 500);
  }
}
```

## backend/packages/shared/src/index.ts

```javascript
export * from './schemas/prompt.js';
export * from './schemas/project.js';
export * from './schemas/task.js';
export * from './schemas/event.js';
export * from './schemas/ingest.js';
export * from './schemas/agent-events.js';
export * from './schemas/checkpoint.js';
export * from './schemas/decision.js';
export * from './schemas/dashboard.js';
export * from './schemas/idempotency.js';
export * from './schemas/query.js';
export * from './schemas/handoff.js';
export * from './types/task-status.js';
export * from './types/priority.js';
export * from './types/actor.js';
export * from './types/events.js';
export * from './errors.js';
export * from './constants.js';
export * from './logger.js';
```

## backend/packages/shared/src/schemas/prompt.ts

```javascript
import { z } from 'zod';
import { queryBoolean } from './query.js';

export const promptSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  template: z.string(),
  arguments: z.array(z.any()).default([]),
  project_id: z.string().nullable(),
  is_builtin: z.boolean(),
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const createPromptSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  template: z.string().min(1),
  arguments: z.array(z.any()).optional(),
  project_id: z.string().optional().nullable(),
  idempotency_key: z.string(),
  agent_id: z.string().optional(),
});

export const updatePromptSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  template: z.string().min(1).optional(),
  arguments: z.array(z.any()).optional(),
  enabled: z.boolean().optional(),
  idempotency_key: z.string(),
});

export const listPromptsQuerySchema = z.object({
  scope: z.enum(['global', 'project']).optional(),
  project_id: z.string().optional(),
  category: z.string().optional(),
  enabled: queryBoolean.optional(),
  include_builtin: queryBoolean.optional(),
  resolved: queryBoolean.optional(),
});

export const togglePromptSchema = z.object({
  enabled: z.boolean(),
  idempotency_key: z.string(),
});

export const previewPromptSchema = z.object({
  args: z.record(z.any()).optional(),
});

export type Prompt = z.infer<typeof promptSchema>;
export type CreatePromptInput = z.infer<typeof createPromptSchema>;
export type UpdatePromptInput = z.infer<typeof updatePromptSchema>;
export type ListPromptsQuery = z.infer<typeof listPromptsQuerySchema>;
```

## backend/package.json

```javascript
{
  "name": "workjournal-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "WorkJournal backend — local-first task continuity system",
  "scripts": {
    "dev": "pnpm --filter @workjournal/core dev",
    "build": "pnpm -r build",
    "build:exe": "tsx scripts/build-exe.ts",
    "smoke:exe": "tsx scripts/smoke-exe.ts",
    "test": "pnpm --filter @workjournal/tests test",
    "test:watch": "pnpm --filter @workjournal/tests test:watch",
    "lint": "pnpm -r lint && eslint scripts/",
    "typecheck": "pnpm -r typecheck && tsc -p scripts/tsconfig.json",
    "start": "pnpm --filter @workjournal/cli start",
    "mcp": "pnpm --filter @workjournal/mcp-adapter start",
    "deploy:local": "./deploy-workjournal.sh"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "drizzle-kit": "^0.30.0",
    "esbuild": "^0.28.2",
    "eslint": "^9.0.0",
    "postject": "1.0.0-alpha.6",
    "tsx": "^4.23.15",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0"
  },
  "engines": {
    "node": ">=22.3.0"
  }
}
```

## backend/packages/core/package.json

```javascript
{
  "name": "@workjournal/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./paths": "./dist/db/paths.js"
  },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "embed": "tsx scripts/embed-ui.ts && tsx scripts/embed-migrations.ts",
    "build": "tsx scripts/embed-ui.ts && tsx scripts/embed-migrations.ts && tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ scripts/",
    "test": "echo 'Tests live in root tests/ directory'"
  },
  "dependencies": {
    "@workjournal/shared": "workspace:*",
    "drizzle-orm": "^0.38.0",
    "fastify": "^5.2.0",
    "fastify-plugin": "^5.0.1",
    "pino": "^9.6.0",
    "uuid": "^11.0.5",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

## backend/packages/mcp-adapter/package.json

```javascript
{
  "name": "@workjournal/mcp-adapter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./autostart": "./dist/autostart.js",
    "./query": "./dist/tools/query.js",
    "./config": "./dist/config.js",
    "./stdio": "./dist/stdio.js",
    "./validate-headers": "./dist/validate-headers.js",
    "./http-server": "./dist/http-server.js",
    "./server-factory": "./dist/server-factory.js"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "echo 'Tests live in root tests/ directory'"
  },
  "dependencies": {
    "@workjournal/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.4",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

## backend/packages/mcp-adapter/src/prompts/registry.ts

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@workjournal/shared';

export interface PromptRow {
  id: string;
  name: string;
  template: string;
  arguments?: any[];
  project_id?: string | null;
  enabled?: boolean;
}

const promptsLogger = createLogger({ component: 'mcp-adapter', module: 'prompts-registry' });

type RegisteredEntry = { promptId: string; registered: ReturnType<McpServer['registerPrompt']> };
const registeredPrompts = new Map<string, RegisteredEntry>();

export function getRegisteredNames(): Set<string> {
  return new Set(registeredPrompts.keys());
}

export async function syncPrompts(
  server: McpServer,
  coreUrl: string,
  projectId?: string,
): Promise<Set<string>> {
  const url = projectId
    ? `${coreUrl}/api/prompts?resolved=true&project_id=${encodeURIComponent(projectId)}`
    : `${coreUrl}/api/prompts?scope=global`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    promptsLogger.error(
      { component: 'mcp-adapter', module: 'prompts-registry', url, projectId, error: String(err) },
      'failed to fetch prompts from core',
    );
    return getRegisteredNames();
  }

  if (!res.ok) {
    promptsLogger.warn(
      {
        component: 'mcp-adapter',
        module: 'prompts-registry',
        url,
        projectId,
        status: res.status,
      },
      'core returned non-OK status for prompts list',
    );
    return getRegisteredNames();
  }

  let prompts: PromptRow[];
  try {
    prompts = (await res.json()) as PromptRow[];
  } catch (err) {
    promptsLogger.error(
      {
        component: 'mcp-adapter',
        module: 'prompts-registry',
        url,
        projectId,
        error: String(err),
      },
      'failed to parse prompts response from core',
    );
    return getRegisteredNames();
  }

  let added = 0;
  let skipped = 0;
  let disabled = 0;
  let removed = 0;
  let reRegistered = 0;

  const currentNames = new Set<string>();

  for (const p of prompts) {
    if (!p.enabled) {
      disabled++;
      continue;
    }
    currentNames.add(p.name);

    const existing = registeredPrompts.get(p.name);
    if (existing) {
      if (existing.promptId === p.id) {
        skipped++;
        continue;
      }
      existing.registered.remove();
      registeredPrompts.delete(p.name);
      reRegistered++;
      promptsLogger.info(
        {
          component: 'mcp-adapter',
          module: 'prompts-registry',
          promptName: p.name,
          oldPromptId: existing.promptId,
          newPromptId: p.id,
          projectId,
        },
        'prompt re-registered (Core ID changed)',
      );
    }

    const registered = server.registerPrompt(p.name, {
      description: p.name,
      argsSchema: {
        request: z.string().optional(),
      },
    }, async (args: any) => {
      const r = await fetch(`${coreUrl}/api/prompts/${p.id}`);
      if (!r.ok) {
        promptsLogger.warn(
          {
            component: 'mcp-adapter',
            module: 'prompts-registry',
            promptName: p.name,
            promptId: p.id,
            status: r.status,
          },
          'prompt no longer available at execution time',
        );
        return { messages: [{ role: 'user', content: { type: 'text', text: `Prompt "${p.name}" is no longer available.` } }] };
      }
      const row = (await r.json()) as PromptRow;
      if (!row.enabled) {
        promptsLogger.warn(
          { component: 'mcp-adapter', module: 'prompts-registry', promptName: p.name, promptId: p.id },
          'prompt is disabled at execution time',
        );
        return { messages: [{ role: 'user', content: { type: 'text', text: `Prompt "${p.name}" is disabled.` } }] };
      }
      let text = row.template;
      for (const [k, v] of Object.entries(args || {})) {
        text = text.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
      }
      if (args?.request) {
        text += `\n\n---\n\nUser request: ${args.request}`;
      }
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    });

    registeredPrompts.set(p.name, { promptId: p.id, registered });
    added++;
  }

  for (const [name, { registered }] of registeredPrompts) {
    if (!currentNames.has(name)) {
      registered.remove();
      registeredPrompts.delete(name);
      removed++;
      promptsLogger.info(
        { component: 'mcp-adapter', module: 'prompts-registry', promptName: name, projectId },
        'prompt removed from registry',
      );
    }
  }

  promptsLogger.info(
    {
      component: 'mcp-adapter',
      module: 'prompts-registry',
      projectId,
      totalFetched: prompts.length,
      added,
      skipped,
      disabled,
      removed,
      reRegistered,
      totalRegistered: registeredPrompts.size,
    },
    'prompt sync complete',
  );

  return getRegisteredNames();
}
```

## backend/packages/mcp-adapter/src/server-factory.ts

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/register.js';
import { syncPrompts, getRegisteredNames } from './prompts/registry.js';
import { createLogger } from '@workjournal/shared';

const mcpLogger = createLogger({ component: 'mcp-adapter', module: 'server-factory' });

export async function createMcpServer(coreUrl: string): Promise<McpServer> {
  mcpLogger.info({ coreUrl }, 'creating MCP server');
  const server = new McpServer({
    name: 'workjournal',
    version: '0.1.0',
  });
  registerTools(server, coreUrl);

  try {
    const registered = await syncPrompts(server, coreUrl, process.env.WORKJOURNAL_PROJECT_ID);
    mcpLogger.info(
      {
        coreUrl,
        projectId: process.env.WORKJOURNAL_PROJECT_ID || null,
        promptCount: registered.size,
      },
      'prompt registry synced',
    );
  } catch (err) {
    mcpLogger.error({ coreUrl, error: String(err) }, 'failed to sync prompt registry on startup');
  }

  void subscribeToPromptChanges(server, coreUrl);

  return server;
}

async function subscribeToPromptChanges(server: McpServer, coreUrl: string): Promise<void> {
  let reconnectMs = 1000;
  const maxReconnectMs = 30000;

  while (true) {
    try {
      const res = await fetch(`${coreUrl}/changes/stream`, {
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok || !res.body) {
        throw new Error(`Changes stream returned ${res.status}`);
      }

      reconnectMs = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            try {
              const event = JSON.parse(payload);
              mcpLogger.debug(
                { component: 'mcp-adapter', module: 'server-factory', event },
                'change stream event received',
              );
              if (event.type === 'prompt') {
                await syncPrompts(server, coreUrl, process.env.WORKJOURNAL_PROJECT_ID);
                server.sendPromptListChanged();
              }
            } catch {
              // Malformed event data — skip
            }
          }
        }
      }
    } catch (err) {
      mcpLogger.error(
        { component: 'mcp-adapter', module: 'server-factory', error: String(err) },
        'changes stream error — reconnecting',
      );
      await new Promise((resolve) => setTimeout(resolve, reconnectMs));
      reconnectMs = Math.min(reconnectMs * 2, maxReconnectMs);
    }
  }
}
```

## backend/packages/mcp-adapter/src/stdio.ts

```javascript
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory.js';
import { createLogger } from '@workjournal/shared';

const stdioLogger = createLogger({ component: 'mcp-adapter', module: 'stdio' });

export async function startStdioServer(coreUrl: string): Promise<void> {
  stdioLogger.info({ coreUrl }, 'connecting MCP server to stdio transport');
  const server = await createMcpServer(coreUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stdioLogger.info({ coreUrl }, 'MCP server connected to stdio transport');
}
```

## backend/packages/mcp-adapter/src/client.ts

```javascript
export async function callCore<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  options?: { headers?: Record<string, string> },
): Promise<T> {
  const url = `${baseUrl}${path}`;

  const requestOptions: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  };

  if (body !== undefined && method !== 'GET') {
    requestOptions.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, requestOptions);
  } catch (err: any) {
    throw new Error(
      `WorkJournal core service is not reachable at ${baseUrl} (${err?.message || err}). ` +
        `Start it with "pnpm start" (service) or "pnpm dev" (watch mode) in backend/, then retry.`,
    );
  }

  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : undefined;
    const message = data?.message || (typeof data?.error === 'object' && data?.error?.message) ||
      `Core service error: ${response.status}`;
    throw new Error(code ? `[${code}] ${message}` : String(message));
  }

  return (data === null ? (text as unknown as T) : (data as T));
}
```

## backend/packages/mcp-adapter/src/tools/register.ts

```javascript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import {
  createTaskSchema,
  updateTaskSchema,
  claimTaskSchema,
  releaseTaskSchema,
  transitionTaskSchema,
  blockTaskSchema,
  cancelTaskSchema,
  interruptTaskSchema,
  unblockTaskSchema,
  completeTaskSchema,
  listTasksQuerySchema,
  createCheckpointSchema,
  createDecisionSchema,
  supersedeDecisionSchema,
  listEventsQuerySchema,
  dashboardQuerySchema,
  startAgentSessionSchema,
  endAgentSessionSchema,
  reportInterruptionSchema,
  reportTimeoutSchema,
  reportProgressMilestoneSchema,
  reportFulfilmentSchema,
  reportVerificationSchema,
  projectIdFromAgentId,
  type IngestEnvelopeInput,
} from '@workjournal/shared';
import { callCore } from '../client.js';
import { buildQueryString } from './query.js';
import { extractSessionId } from './session-meta.js';

type Json = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const asJson = (result: unknown): Json => ({
  content: [
    { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
  ],
});

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Thin forwarding layer (root AGENTS.md): every input schema comes from
 * `@workjournal/shared`, so the tools cannot drift from the HTTP contract, and no
 * business logic lives here.
 */
export function registerTools(server: McpServer, coreUrl: string) {
  const tool = (
    name: string,
    description: string,
    inputSchema: ZodRawShape,
    handler: (args: any, extra?: any) => Promise<unknown>,
  ) =>
    server.registerTool(name, { title: name, description, inputSchema }, async (args: any, extra: any) => {
      try {
        return asJson(await handler(args, extra));
      } catch (err) {
        return { ...asJson(errorMessage(err)), isError: true };
      }
    });

  const query = (params: Record<string, unknown>) => buildQueryString(params);

  const reportEvent = (type: string | ((args: any) => string), payloadFields: (args: any) => Record<string, unknown>) =>
    (args: any) => {
      const project_id = args.project_id ?? projectIdFromAgentId(args.agent_id);
      if (!project_id) {
        throw new Error(
          `Could not determine project_id from agent_id "${args.agent_id}" — pass project_id explicitly.`,
        );
      }
      const envelope: IngestEnvelopeInput = {
        event_id: args.idempotency_key,
        type: typeof type === 'function' ? type(args) : type,
        source: `agent:${args.agent_id}`,
        actor: args.agent_id,
        ...(args.task_id ? { task_id: args.task_id } : {}),
        payload: payloadFields(args),
      };
      return callCore(
        coreUrl,
        'POST',
        `/api/ingest/events${query({ project_id })}`,
        { events: [envelope] },
      );
    };

  tool(
    'create_task',
    'Create a task in a project. Requires your agent_id (format <agent-string>_<project-id>), an objective-free title, and a fresh idempotency_key (reuse a key only to retry the identical call).',
    createTaskSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/tasks', args),
  );

  tool(
    'get_task',
    'Fetch one task by id, including its current status and owner.',
    { task_id: z.string().min(1) },
    (args) => callCore(coreUrl, 'GET', `/api/tasks/${args.task_id}`),
  );

  tool(
    'list_tasks',
    'List tasks in a project, optionally filtered by status and priority, with limit/offset paging (newest first).',
    listTasksQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/tasks${query(args)}`),
  );

  tool(
    'update_task',
    'Update the title, objective, priority or acceptance criteria of a task. Requires the current owner agent_id and an idempotency_key.',
    { task_id: z.string().min(1), ...updateTaskSchema.shape },
    (args) => callCore(coreUrl, 'PATCH', `/api/tasks/${args.task_id}`, args),
  );

  tool(
    'claim_task',
    'Claim an open task (or recover an interrupted one, which reassigns ownership to you). When your client attaches a session id in the tool-call _meta, the claim also binds session to task for event correlation.',
    claimTaskSchema.shape,
    (args, extra) => {
      const sessionId = args.session_id ?? extractSessionId(extra?._meta);
      return callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/claim`, {
        ...args,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
    },
  );

  tool(
    'release_task',
    'Release a task you own, returning it to open.',
    releaseTaskSchema.shape,
    (args) => callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/release`, args),
  );

  const transition =
    (target_status: string) =>
    (args: any) =>
      callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/transition`, {
        ...args,
        target_status,
      });

  tool(
    'block_task',
    'Mark your in-progress task blocked. A reason is required.',
    blockTaskSchema.shape,
    transition('blocked'),
  );

  tool(
    'unblock_task',
    'Return your blocked task to open. A resolution_note describing how it was unblocked is required.',
    unblockTaskSchema.shape,
    transition('open'),
  );

  tool(
    'complete_task',
    'Mark your in-progress task completed (terminal).',
    completeTaskSchema.shape,
    transition('completed'),
  );

  tool(
    'cancel_task',
    'Cancel a task you own (terminal). A reason is required.',
    cancelTaskSchema.shape,
    transition('cancelled'),
  );

  tool(
    'mark_task_interrupted',
    'Mark your in-progress task interrupted because the attempt ended without completion. A reason is required; another agent can then recover it with claim_task.',
    interruptTaskSchema.shape,
    transition('interrupted'),
  );

  tool(
    'record_checkpoint',
    'Record a progress checkpoint on a task: what is done, findings, unresolved issues and next steps.',
    createCheckpointSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/checkpoints', args),
  );

  tool(
    'record_decision',
    'Record a decision on a task, with rationale and rejected alternatives, so it survives the conversation.',
    createDecisionSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/decisions', args),
  );

  tool(
    'supersede_decision',
    'Replace one of the task\'s decisions: the old record is kept and marked superseded, the replacement becomes active.',
    supersedeDecisionSchema.shape,
    (args) =>
      callCore(coreUrl, 'POST', `/api/decisions/${args.decision_id}/supersede`, args),
  );

  tool(
    'get_task_history',
    'Chronological, append-only event history for a task (creation, claims, transitions, checkpoints, decisions).',
    listEventsQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/events${query(args)}`),
  );

  tool(
    'get_resume_context',
    'Deterministic resume context for a task: identity, latest checkpoint, active decisions, progress, unresolved issues and recent events.',
    { task_id: z.string().min(1) },
    (args) => callCore(coreUrl, 'GET', `/api/resume${query(args)}`),
  );

  tool(
    'export_handoff',
    'Export a task handoff as JSON or Markdown for another agent or a review.',
    { task_id: z.string().min(1), format: z.enum(['json', 'markdown']).default('json') },
    (args) =>
      callCore(coreUrl, 'GET', `/api/export/${args.format || 'json'}${query({ task_id: args.task_id })}`),
  );

  tool(
    'get_dashboard',
    'Dashboard overview: task stats, recent tasks and the project scope list. Pass project_id to scope to one project; omit it for all projects.',
    dashboardQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/dashboard${query(args)}`),
  );

  tool(
    'start_agent_session',
    'Record the start of an agent session (ledger event, no task transition). Requires your agent_id and session_id plus a fresh idempotency_key.',
    startAgentSessionSchema.shape,
    reportEvent('agent_session_started', (a) => ({ agent_id: a.agent_id, session_id: a.session_id })),
  );

  tool(
    'end_agent_session',
    'Record the end of an agent session with a completion reason (ledger event, no task transition).',
    endAgentSessionSchema.shape,
    reportEvent('agent_session_ended', (a) => ({
      agent_id: a.agent_id,
      session_id: a.session_id,
      reason: a.reason,
    })),
  );

  tool(
    'report_interruption',
    'Record that the agent session was interrupted (ledger event; task status is not changed).',
    reportInterruptionSchema.shape,
    reportEvent('agent_interrupted', (a) => ({
      agent_id: a.agent_id,
      session_id: a.session_id,
      ...(a.reason ? { reason: a.reason } : {}),
    })),
  );

  tool(
    'report_timeout',
    'Record that the agent session timed out (ledger event; task status is not changed).',
    reportTimeoutSchema.shape,
    reportEvent('agent_timed_out', (a) => ({
      agent_id: a.agent_id,
      session_id: a.session_id,
      ...(a.timeout_ms !== undefined ? { timeout_ms: a.timeout_ms } : {}),
    })),
  );

  tool(
    'report_progress_milestone',
    'Record a progress milestone on a task or project (ledger event, no task transition).',
    reportProgressMilestoneSchema.shape,
    reportEvent('progress_milestone', (a) => ({
      agent_id: a.agent_id,
      ...(a.session_id ? { session_id: a.session_id } : {}),
      summary: a.summary,
    })),
  );

  tool(
    'report_fulfilment',
    'Record fulfilment evidence (summary, findings, blockers, next steps, files changed). Ledger event; triggers checkpoint evaluation, never a task transition.',
    reportFulfilmentSchema.shape,
    reportEvent('progress_fulfilment', (a) => ({
      agent_id: a.agent_id,
      ...(a.session_id ? { session_id: a.session_id } : {}),
      summary: a.summary,
      ...(a.findings ? { findings: a.findings } : {}),
      ...(a.blockers ? { blockers: a.blockers } : {}),
      ...(a.next_steps ? { next_steps: a.next_steps } : {}),
      ...(a.files_changed ? { files_changed: a.files_changed } : {}),
    })),
  );

  tool(
    'report_verification',
    'Record a verification outcome: passed, failed or skipped, with check_type and detail (ledger event, no task transition).',
    reportVerificationSchema.shape,
    reportEvent(
      (a) => `verification_${a.outcome}`,
      (a) => ({
        agent_id: a.agent_id,
        ...(a.session_id ? { session_id: a.session_id } : {}),
        check_type: a.check_type,
        ...(a.detail ? { detail: a.detail } : {}),
      }),
    ),
  );
}
```

## backend/packages/mcp-adapter/src/config.ts

```javascript
export interface AdapterConfig {
  /** Which transport to run: 'stdio' (default, native dev) or 'http' (Docker / remote clients). */
  transport: 'stdio' | 'http';
  /** Core service base URL. In Docker this is the Compose service name, e.g. http://core:3737. */
  coreUrl: string;
  /** Bind address for the HTTP transport (loopback by default). */
  httpHost: string;
  /** Port for the HTTP transport. */
  httpPort: number;
  /** Exact `host:port` values allowed in the Host header (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Exact origins allowed in the Origin header; absent Origin is always allowed (non-browser clients). */
  allowedOrigins: string[];
  /** Optional bearer token required on /mcp when set (write-protection for HTTP mode). */
  authToken: string | undefined;
  /** Probe the core service and start it when it is unreachable (stdio only — decision D-013). */
  autostart: boolean;
  /** Ask an autostarted core to serve the dashboard too (`mcp --with-ui`). */
  withUi: boolean;
  /** How long to wait for an autostarted core to answer /health. */
  autostartTimeoutMs: number;
  /** How often the stdio adapter refreshes its client-heartbeat file. */
  heartbeatSeconds: number;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseFlag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean flag (1/0, true/false) — got "${raw}".`);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

export function loadAdapterConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const rawTransport = (env.MCP_TRANSPORT || 'stdio').toLowerCase();
  if (rawTransport !== 'stdio' && rawTransport !== 'http') {
    throw new Error(
      `MCP_TRANSPORT must be "stdio" or "http" (got "${env.MCP_TRANSPORT}").`,
    );
  }

  const httpPort = parseInt(env.MCP_PORT || '3738', 10);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`MCP_PORT must be a valid TCP port (got "${env.MCP_PORT}").`);
  }

  const httpHost = env.MCP_HTTP_HOST || '127.0.0.1';

  return {
    transport: rawTransport,
    coreUrl: env.WORKJOURNAL_CORE_URL || 'http://127.0.0.1:3737',
    httpHost,
    httpPort,
    allowedHosts: splitList(env.MCP_ALLOWED_HOSTS) ?? [
      `127.0.0.1:${httpPort}`,
      `localhost:${httpPort}`,
      `[::1]:${httpPort}`,
    ],
    allowedOrigins: splitList(env.MCP_ALLOWED_ORIGINS) ?? [
      `http://127.0.0.1:${httpPort}`,
      `http://localhost:${httpPort}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ],
    authToken: env.MCP_AUTH_TOKEN || undefined,
    autostart: parseFlag(env.MCP_AUTOSTART, true, 'MCP_AUTOSTART'),
    withUi: parseFlag(env.MCP_WITH_UI, false, 'MCP_WITH_UI'),
    autostartTimeoutMs: parsePositiveInt(
      env.MCP_AUTOSTART_TIMEOUT_MS,
      10_000,
      'MCP_AUTOSTART_TIMEOUT_MS',
    ),
    heartbeatSeconds: parsePositiveInt(env.MCP_HEARTBEAT_SECONDS, 30, 'MCP_HEARTBEAT_SECONDS'),
  };
}
```

## backend/packages/mcp-adapter/src/autostart.ts

```javascript
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { AdapterConfig } from './config.js';
import { createLogger, child } from '@workjournal/shared';
import { startStdioServer } from './stdio.js';

export const HEARTBEAT_DIR_NAME = 'mcp-heartbeats';

export function expandHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WORKJOURNAL_HOME || '~/.workjournal';
  return raw.replace(/^~/, env.HOME || env.USERPROFILE || '.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

export interface SpawnTarget {
  command: string;
  prefixArgs: string[];
}

export function resolveSpawnTarget(env: NodeJS.ProcessEnv = process.env): SpawnTarget | null {
  if (/^workjournal(\.exe)?$/i.test(basename(process.execPath))) {
    return { command: process.execPath, prefixArgs: [] };
  }
  const entry = env.MCP_AUTOSTART_ENTRY;
  if (entry && existsSync(entry)) {
    return { command: process.execPath, prefixArgs: [entry] };
  }
  return null;
}

const log = createLogger({ component: 'mcp-adapter' });

function note(message: string): void {
  process.stderr.write(`[workjournal] ${message}\n`);
  log.debug({ component: 'mcp-adapter', stream: 'stderr' }, message);
}

async function ensureCore(config: AdapterConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const base = config.coreUrl.replace(/\/+$/, '');
  const healthUrl = `${base}/health`;
  const actionable = `WorkJournal core service is not reachable at ${base}. ` +
    'Start it with "workjournal start --with-ui" and retry.';

  const healthy = await probe(healthUrl, 2_000);
  if (healthy?.ok) {
    const pid = describeLocalPid(env);
    log.info(
      { component: 'mcp-adapter', action: 'attach-core', coreUrl: base, pid },
      'connecting to existing core',
    );
    note(`connecting to existing core running at ${base} (pid: ${pid})`);
    return;
  }

  if (!config.autostart) {
    log.warn({ component: 'mcp-adapter', action: 'attach-core', coreUrl: base, autostart: false }, 'core is down and autostart is disabled');
    throw new Error(actionable);
  }

  const target = resolveSpawnTarget(env);
  if (!target) {
    log.error(
      { component: 'mcp-adapter', action: 'autostart-core', coreUrl: base },
      'autostart unavailable in this runtime',
    );
    throw new Error(actionable);
  }

  await spawnCoreDetached(config, target, env);
}

async function spawnCoreDetached(
  config: AdapterConfig,
  target: SpawnTarget,
  env: NodeJS.ProcessEnv,
  replacedPid?: number,
): Promise<void> {
  const base = config.coreUrl.replace(/\/+$/, '');
  const healthUrl = `${base}/health`;

  const homeDir = expandHomeDir(env);
  mkdirSync(homeDir, { recursive: true });
  const logPath = join(homeDir, 'service.log');
  const logFd = openSync(logPath, 'a');

  const args = [...target.prefixArgs, 'start', ...(config.withUi ? ['--with-ui'] : [])];
  let child: ChildProcess;
  let spawnError: Error | null = null;
  try {
    child = spawn(target.command, args, {
      env: { ...env, WORKJOURNAL_AUTOSTART: '1' },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
  } catch (err) {
    spawnError = err instanceof Error ? err : new Error(String(err));
    child = null as unknown as ChildProcess;
  }
  child?.on('error', (err: Error) => {
    spawnError = err;
  });
  child?.unref();

  const deadline = Date.now() + config.autostartTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      log.error(
        { component: 'mcp-adapter', action: 'autostart-core', error: spawnError.message },
        'could not start core service',
      );
      throw new Error(`Could not start the WorkJournal core service: ${spawnError.message}. ${actionable}`);
    }
    const attempt = await probe(healthUrl, 2_000);
    if (attempt?.ok) {
      log.info(
        { component: 'mcp-adapter', action: 'autostart-core', coreUrl: base },
        'core service became healthy',
      );
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `The auto-started WorkJournal core service did not become healthy within ` +
      `${config.autostartTimeoutMs}ms — check ${logPath}. ${actionable}`,
  );
}

function describeLocalPid(env: NodeJS.ProcessEnv): string {
  const pid = readServicePid(expandHomeDir(env));
  if (pid === null) return 'unknown';
  try {
    process.kill(pid, 0);
    return String(pid);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? String(pid) : 'unknown';
  }
}

function readServicePid(homeDir: string): number | null {
  try {
    const pid = parseInt(readFileSync(join(homeDir, 'service.pid'), 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function startHeartbeat(
  config: Pick<AdapterConfig, 'heartbeatSeconds'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = join(expandHomeDir(env), HEARTBEAT_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);

  const touch = (): void => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    } catch {
      // Home unavailable — the core's idle window still bounds the service.
    }
  };
  touch();
  const timer = setInterval(touch, config.heartbeatSeconds * 1_000);
  timer.unref();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    try {
      unlinkSync(file);
    } catch {
      // Already gone (or never written) — nothing to do.
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    log.info({ component: 'mcp-adapter', pid: process.pid }, 'SIGINT received — stopping heartbeat');
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    log.info({ component: 'mcp-adapter', pid: process.pid }, 'SIGTERM received — stopping heartbeat');
    cleanup();
    process.exit(143);
  });

  const sayGoodbye = (): void => {
    log.info({ component: 'mcp-adapter', pid: process.pid }, 'stdio client disconnected — stopping');
    cleanup();
    process.exit(0);
  };
  process.stdin.on('end', sayGoodbye);
  process.stdin.on('close', sayGoodbye);
  process.stdin.on('error', sayGoodbye);
}

export async function runStdioAdapter(config: AdapterConfig): Promise<void> {
  log.info({ component: 'mcp-adapter', action: 'start', coreUrl: config.coreUrl }, 'starting MCP adapter');
  await ensureCore(config);
  startHeartbeat(config);
  await startStdioServer(config.coreUrl);
}
```

## backend/packages/mcp-adapter/src/index.ts

```javascript
import { loadAdapterConfig } from './config.js';
import { runStdioAdapter } from './autostart.js';
import { startHttpServer } from './http-server.js';

const config = loadAdapterConfig();

if (config.transport === 'http') {
  await startHttpServer(config);
} else {
  await runStdioAdapter(config);
}
```




