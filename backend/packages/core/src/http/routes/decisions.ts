import type { FastifyInstance } from 'fastify';
import {
  createDecisionSchema,
  supersedeDecisionSchema,
  listDecisionsQuerySchema,
  CreateDecisionInput,
  SupersedeDecisionInput,
  ListDecisionsQuery,
  ValidationError,
} from '@workjournal/shared';
import { validateBody, validateQuery, operationInput } from '../hooks/validation.js';
import { buildServices } from '../services.js';

export async function registerDecisionRoutes(server: FastifyInstance) {
  server.post('/', { preHandler: [validateBody(createDecisionSchema)] }, async (request, reply) => {
    const input = request.body as CreateDecisionInput;
    const scope = server.projectDbs.forTask(input.task_id);
    const decision = await buildServices(scope.db).decisions.createDecision({
      taskId: input.task_id,
      agentId: input.agent_id,
      statement: input.statement,
      rationale: input.rationale,
      alternatives: input.alternatives,
      supportingEventIds: input.supporting_event_ids,
      expectedVersion: input.expected_version,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    });
    return reply.status(201).send(decision);
  });

  server.get('/', { preHandler: [validateQuery(listDecisionsQuerySchema)] }, async (request) => {
    const query = request.query as ListDecisionsQuery;
    const scope = server.projectDbs.forTask(query.task_id);
    return buildServices(scope.db).decisions.listDecisions(query.task_id, query.include_superseded);
  });

  server.post('/:id/supersede', { preHandler: [validateBody(supersedeDecisionSchema)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = request.body as SupersedeDecisionInput;
    if (id !== input.decision_id) {
      throw new ValidationError(`Decision id in the path (${id}) does not match the body (${input.decision_id}).`);
    }
    const scope = server.projectDbs.forTask(input.task_id);
    const decision = await buildServices(scope.db).decisions.supersedeDecision({
      taskId: input.task_id,
      decisionId: input.decision_id,
      agentId: input.agent_id,
      replacementStatement: input.replacement_statement,
      replacementRationale: input.replacement_rationale,
      expectedVersion: input.expected_version,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    });
    return reply.status(201).send(decision);
  });
}
