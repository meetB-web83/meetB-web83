import type { FastifyInstance } from 'fastify';
import {
  createCheckpointSchema,
  listCheckpointsQuerySchema,
  CreateCheckpointInput,
  ListCheckpointsQuery,
} from '@workjournal/shared';
import { validateBody, validateQuery, operationInput } from '../hooks/validation.js';
import { buildServices } from '../services.js';

export async function registerCheckpointRoutes(server: FastifyInstance) {
  server.post('/', { preHandler: [validateBody(createCheckpointSchema)] }, async (request, reply) => {
    const input = request.body as CreateCheckpointInput;
    const scope = server.projectDbs.forTask(input.task_id);
    const checkpoint = await buildServices(scope.db).checkpoints.createCheckpoint({
      taskId: input.task_id,
      agentId: input.agent_id,
      progressSummary: input.progress_summary,
      completedWork: input.completed_work,
      currentFindings: input.current_findings,
      unresolvedIssues: input.unresolved_issues,
      nextSteps: input.next_steps,
      fileReferences: input.file_references,
      expectedVersion: input.expected_version,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    });
    return reply.status(201).send(checkpoint);
  });

  server.get('/', { preHandler: [validateQuery(listCheckpointsQuerySchema)] }, async (request) => {
    const query = request.query as ListCheckpointsQuery;
    const scope = server.projectDbs.forTask(query.task_id);
    return buildServices(scope.db).checkpoints.listCheckpoints(query.task_id, query.limit, query.offset);
  });

  server.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const scope = server.projectDbs.forCheckpoint(id);
    return buildServices(scope.db).checkpoints.getCheckpoint(id);
  });
}
