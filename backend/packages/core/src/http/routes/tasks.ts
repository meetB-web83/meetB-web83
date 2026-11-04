import type { FastifyInstance } from 'fastify';
import {
  createTaskSchema,
  updateTaskSchema,
  claimTaskSchema,
  releaseTaskSchema,
  transitionTaskSchema,
  listTasksQuerySchema,
  taskCountsQuerySchema,
  CreateTaskInput,
  UpdateTaskInput,
  ClaimTaskInput,
  ReleaseTaskInput,
  TransitionTaskInput,
  ListTasksQuery,
  TaskCountsQuery,
  ValidationError,
} from '@workjournal/shared';
import { validateBody, validateQuery, operationInput } from '../hooks/validation.js';
import { buildServices } from '../services.js';
import { DashboardService } from '../../domain/dashboard-service.js';

export async function registerTaskRoutes(server: FastifyInstance) {
  server.post('/', { preHandler: [validateBody(createTaskSchema)] }, async (request, reply) => {
    const input = request.body as CreateTaskInput & { agentCall?: boolean };
    if (!input.project_id) {
      throw new ValidationError('project_id is required');
    }
    const db = server.projectDbs.forProject(input.project_id);
    const task = await buildServices(db).tasks.createTask({
      projectId: input.project_id,
      title: input.title,
      objective: input.objective,
      acceptanceCriteria: input.acceptance_criteria,
      priority: input.priority,
      agentId: input.agent_id,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    }, input.agentCall);
    return reply.status(201).send(task);
  });

  server.get('/', { preHandler: [validateQuery(listTasksQuerySchema)] }, async (request) => {
    const query = request.query as ListTasksQuery & { agentCall?: boolean };
    const agentCall = query.agentCall;
    if (query.project_id) {
      const db = server.projectDbs.forProject(query.project_id);
      return buildServices(db).tasks.listTasks({
        projectId: query.project_id,
        status: query.status,
        priority: query.priority,
        limit: query.limit,
        offset: query.offset,
        agentCall,
      });
    }

    // No project_id: aggregate newest-first across all available project DBs (the
    // dashboard home page shows recent tasks from all projects). Shared with the
    // dashboard overview service so both endpoints page one code path.
    return new DashboardService(server.projectDbs).listTasksAcrossProjects({
      status: query.status,
      priority: query.priority,
      limit: query.limit,
      offset: query.offset,
      agentCall,
    });
  });

  server.get('/counts', { preHandler: [validateQuery(taskCountsQuerySchema)] }, async (request) => {
    const query = request.query as TaskCountsQuery & { agentCall?: boolean };
    const db = server.projectDbs.forProject(query.project_id);
    const rows = db.raw
      .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.n;
    }
    // Ensure all statuses are present with 0 if missing
    const allStatuses = ['open', 'in_progress', 'blocked', 'interrupted', 'completed', 'cancelled'];
    for (const status of allStatuses) {
      if (counts[status] === undefined) counts[status] = 0;
    }
    return counts;
  });

  server.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const scope = server.projectDbs.forTask(id);
    const query = request.query as { agentCall?: boolean };
    return buildServices(scope.db).tasks.getTask(id, query.agentCall);
  });

  server.patch('/:id', { preHandler: [validateBody(updateTaskSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as UpdateTaskInput & { agentCall?: boolean };
    const scope = server.projectDbs.forTask(id);
    return buildServices(scope.db).tasks.updateTask(
      id,
      input.agent_id,
      {
        title: input.title,
        objective: input.objective,
        acceptanceCriteria: input.acceptance_criteria,
        priority: input.priority,
      },
      { key: input.idempotency_key, input: operationInput(input) },
      input.agentCall,
    );
  });

  const assertTaskParam = (paramId: string, bodyTaskId: string) => {
    if (paramId !== bodyTaskId) {
      throw new ValidationError(`Task id in the path (${paramId}) does not match the body (${bodyTaskId}).`);
    }
  };

  server.post('/:id/claim', { preHandler: [validateBody(claimTaskSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as ClaimTaskInput & { agentCall?: boolean };
    assertTaskParam(id, input.task_id);
    const scope = server.projectDbs.forTask(id);
    return buildServices(scope.db).tasks.claimTask(
      id,
      input.agent_id,
      { key: input.idempotency_key, input: operationInput(input) },
      input.session_id ?? null,
      input.agentCall,
    );
  });

  server.post('/:id/release', { preHandler: [validateBody(releaseTaskSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as ReleaseTaskInput & { agentCall?: boolean };
    assertTaskParam(id, input.task_id);
    const scope = server.projectDbs.forTask(id);
    return buildServices(scope.db).tasks.releaseTask(
      id,
      input.agent_id,
      { key: input.idempotency_key, input: operationInput(input) },
      input.agentCall,
    );
  });

  server.post('/:id/transition', { preHandler: [validateBody(transitionTaskSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as TransitionTaskInput & { agentCall?: boolean };
    assertTaskParam(id, input.task_id);
    const scope = server.projectDbs.forTask(id);
    return buildServices(scope.db).tasks.transitionTask(
      id,
      input.agent_id,
      input.target_status,
      input.reason,
      input.resolution_note,
      { key: input.idempotency_key, input: operationInput(input) },
      input.agentCall,
    );
  });
}
