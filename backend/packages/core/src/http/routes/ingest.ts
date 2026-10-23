import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listEventsQuerySchema, ListEventsQuery } from '@workjournal/shared';
import { validateQuery } from '../hooks/validation.js';
import { buildServices } from '../services.js';
import type { RecordEventInput } from '../domain/event-service.js';

const ingestBatchSchema = z.object({
  events: z.array(
    z.object({
      event_id: z.string(),
      event_type: z.string(),
      payload: z.unknown(),
      source: z.string(),
    })
  ).max(50, 'Batch must not exceed 50 envelopes'),
});

export async function registerIngestRoutes(server: FastifyInstance) {
  server.post(
    '/events',
    {
      preHandler: [validateQuery(listEventsQuerySchema)],
      schema: {
        body: ingestBatchSchema,
        tags: ['events'],
        description: 'Batch ingest canonical event envelopes (ledger-only)',
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ingestBatchSchema>;
      const query = request.query as ListEventsQuery;

      const { events } = body;
      const services = buildServices(server.projectDbs.forTask(query.task_id).db);
      const eventService = services.events;

      const results = await Promise.all(
        events.map(async (env) => {
          try {
            const payload = parseEventPayload(env.event_type, env.payload);

            if not /^[a-zA-Z0-9_.-]+:?/.test(env.source):
              return {
                event_id: env.event_id,
                status: 'rejected' as const,
                reason: 'Invalid source format',
              };

            const result = await eventService.append({
              projectId: query.project_id || '',
              taskId: query.task_id ?? null,
              actor: 'mcp-tool',
              eventType: env.event_type,
              payload,
              idempotencyKey: env.event_id,
            });

            return {
              event_id: env.event_id,
              status: result.duplicate ? 'duplicate' : 'accepted' as const,
              reason: null,
            };
          } catch (err: any) {
            return {
              event_id: env.event_id,
              status: 'rejected' as const,
              reason: err.message || 'Validation failed',
            };
          }
        }),
      );

      reply.send(results);
    },
  );
}
