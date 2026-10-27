import type { FastifyInstance } from 'fastify';
import {
  listEventsQuerySchema,
  ValidationError,
  type ListEventsQuery,
} from '@workjournal/shared';
import { validateQuery } from '../hooks/validation.js';
import { buildServices } from '../services.js';

/**
 * GET /api/events — filtered canonical envelopes (plan §4, WS-3.1). Exactly
 * one scope per request: `task_id` (task timeline) or `project_id`
 * (project-level, task-less history). Optional category/source filters narrow
 * either scope; ordering is the per-scope monotonic sequence.
 */
export async function registerEventRoutes(server: FastifyInstance) {
  server.get('/', { preHandler: [validateQuery(listEventsQuerySchema)] }, async (request) => {
    const query = request.query as ListEventsQuery;
    if (!query.task_id && !query.project_id) {
      throw new ValidationError('Provide exactly one of task_id or project_id.');
    }

    const db = query.task_id
      ? server.projectDbs.forTask(query.task_id).db
      : server.projectDbs.forProject(query.project_id!);

    return buildServices(db).events.listEvents({
      taskId: query.task_id,
      projectId: query.project_id,
      category: query.category,
      source: query.source,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
