import type { FastifyInstance } from 'fastify';
import { dashboardQuerySchema, DashboardQuery } from '@workjournal/shared';
import { validateQuery } from '../hooks/validation.js';
import { DashboardService } from '../../domain/dashboard-service.js';

export async function registerDashboardRoutes(server: FastifyInstance) {
  const dashboard = new DashboardService(server.projectDbs);

  server.get('/', { preHandler: [validateQuery(dashboardQuerySchema)] }, async (request) => {
    const query = request.query as DashboardQuery;
    return dashboard.getOverview({ projectId: query.project_id, recentLimit: query.recent_limit });
  });
}
