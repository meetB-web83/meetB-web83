import type { FastifyInstance } from 'fastify';
import { listEventsQuerySchema, ListEventsQuery } from '@workjournal/shared';
import { validateQuery } from '../hooks/validation.js';
import { buildServices } from '../services.js';

export async function registerEventRoutes(server: FastifyInstance) {
  server.get('/', { preHandler: [validateQuery(listEventsQuerySchema)] }, async (request) => {
    const query = request.query as ListEventsQuery;
    const scope = server.projectDbs.forTask(query.task_id);
    return buildServices(scope.db).events.listEvents(query.task_id, query.limit, query.offset);
  });
}
