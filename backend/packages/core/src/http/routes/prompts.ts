import type { FastifyInstance } from 'fastify';
import {
  createPromptSchema,
  updatePromptSchema,
  listPromptsQuerySchema,
  togglePromptSchema,
  previewPromptSchema,
  CreatePromptInput,
  UpdatePromptInput,
  ListPromptsQuery,
} from '@workjournal/shared';
import { validateBody, validateQuery, operationInput } from '../hooks/validation.js';

export async function registerPromptRoutes(server: FastifyInstance) {
  server.get('/', { preHandler: [validateQuery(listPromptsQuerySchema)] }, async (request) => {
    const query = request.query as ListPromptsQuery;
    return server.services.prompts.list({
      scope: query.scope,
      projectId: query.project_id,
      category: query.category,
      enabled: query.enabled,
      includeBuiltin: query.include_builtin,
      resolved: query.resolved,
    });
  });

  server.post('/', { preHandler: [validateBody(createPromptSchema)] }, async (request, reply) => {
    const input = request.body as CreatePromptInput;
    const prompt = await server.services.prompts.create({
      name: input.name,
      description: input.description,
      category: input.category,
      template: input.template,
      args: input.arguments,
      projectId: input.project_id,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    });
    return reply.status(201).send(prompt);
  });

  server.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return server.services.prompts.get(id);
  });

  server.patch('/:id', { preHandler: [validateBody(updatePromptSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as UpdatePromptInput;
    if (id !== undefined && (input as any).id && id !== (input as any).id) {
      // allow
    }
    return server.services.prompts.update({
      id,
      name: input.name,
      description: input.description,
      category: input.category,
      template: input.template,
      args: input.arguments,
      enabled: input.enabled,
      expectedVersion: input.expected_version,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    });
  });

  server.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await server.services.prompts.remove(id);
    return reply.status(204).send();
  });

  server.post('/:id/toggle', { preHandler: [validateBody(togglePromptSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as any;
    return server.services.prompts.toggle(id, input.enabled, input.expected_version, { key: input.idempotency_key, input: operationInput(input) });
  });

  server.post('/:id/preview', { preHandler: [validateBody(previewPromptSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as any;
    return server.services.prompts.preview(id, input.args || {});
  });
}