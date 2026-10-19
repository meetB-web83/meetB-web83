import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateQuery } from '../hooks/validation.js';
import { buildServices } from '../services.js';

const resumeQuerySchema = z.object({
  task_id: z.string().min(1),
  size_limit: z.coerce.number().int().positive().optional(),
});

export async function registerResumeRoutes(server: FastifyInstance) {
  server.get('/', { preHandler: [validateQuery(resumeQuerySchema)] }, async (request) => {
    const query = request.query as z.infer<typeof resumeQuerySchema>;
    const scope = server.projectDbs.forTask(query.task_id);
    const context = await buildServices(scope.db).resume.build(query.task_id, query.size_limit);
    return { context };
  });
}
