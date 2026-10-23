import type { FastifyInstance } from 'fastify';
import { listEventsQuerySchema, ListEventsQuery } from '@workjournal/shared';
import { validateQuery } from '../hooks/validation.js';
import { buildServices } from '../services.js';

export async function registerEventRoutes(server: FastifyInstance) {
  server.get('/', { preHandler: [validateQuery(listEventsQuerySchema)] }, async (request) => {
    const query = request.query as ListEventsQuery;
    // For project-level events (task_id is NULL), use the project DB directly
    const taskId = query.task_id || null;
    const scope = taskId ? server.projectDbs.forTask(taskId) : server.projectDbs.forProject(query.project_id || '');
    return buildServices(scope.db).events.listEvents(taskId, query.limit, query.offset, {
      category: query.category,
      source: query.source,
      projectId: query.project_id,
    });
  });
}
