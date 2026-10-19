import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateQuery } from '../hooks/validation.js';
import { buildServices } from '../services.js';

const exportQuerySchema = z.object({
  task_id: z.string().min(1),
});

export async function registerExportRoutes(server: FastifyInstance) {
  server.get('/json', { preHandler: [validateQuery(exportQuerySchema)] }, async (request) => {
    const { task_id } = request.query as z.infer<typeof exportQuerySchema>;
    const scope = server.projectDbs.forTask(task_id);
    return buildServices(scope.db).jsonExport.exportTask(task_id);
  });

  server.get('/markdown', { preHandler: [validateQuery(exportQuerySchema)] }, async (request, reply) => {
    const { task_id } = request.query as z.infer<typeof exportQuerySchema>;
    const scope = server.projectDbs.forTask(task_id);
    const markdown = await buildServices(scope.db).markdownExport.exportTask(task_id);
    return reply.type('text/markdown').send(markdown);
  });
}
