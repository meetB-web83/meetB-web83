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
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerUiRoutes } from './ui.js';
import { validateProjectsMount } from '../db/paths.js';
import { projectMigrationsSource } from '../db/migrations-source.js';
import type { UiAssets } from '../ui/ui-assets.js';

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
  /**
   * When provided, the dashboard is served from these in-memory assets on the
   * same origin as the API (`--with-ui` / SEA executable). Omitted → API-only,
   * exactly the previous behaviour.
   */
  ui?: UiAssets | null;
}

export function buildServer(db: Database, config: Config, options: BuildServerOptions = {}) {
  // Startup gate: PROJECTS_DIRECTORY configured but the container mount is
  // missing/unreadable → actionable failure before any request is served.
  const mountError = validateProjectsMount();
  if (mountError) throw new Error(mountError);

  const server = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1_048_576,
  });

  const projectDbs = new ProjectDbResolver(db, projectMigrationsSource());

  server.decorate('registryDb', db);
  server.decorate('projectDbs', projectDbs);
  server.decorate('services', buildServices(db, config.pathContext));
  server.decorate('config', config);

  server.addHook('onClose', async () => {
    projectDbs.closeAll();
  });

  server.setErrorHandler((error: any, request, reply) => {
    if (error?.name === 'WorkJournalError') {
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
  server.register(registerDashboardRoutes, { prefix: '/api/dashboard' });

  // Liveness probe for container health checks: no DB access, no auth (root
  // AGENTS.md: no authentication; the route reveals nothing).
  server.get('/health', async () => ({ status: 'ok' }));

  if (options.ui) registerUiRoutes(server, options.ui);

  return server;
}
