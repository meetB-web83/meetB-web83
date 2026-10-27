import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ingestBatchSchema,
  isIngestibleType,
  ValidationError,
  type IngestBatchInput,
} from '@workjournal/shared';
import { validateBody, validateQuery } from '../hooks/validation.js';
import { IngestService } from '../../domain/ingest-service.js';

const ingestQuerySchema = z.object({
  project_id: z.string().min(1),
});

/**
 * POST /api/ingest/events — ledger-only batch ingestion (plan §10.5, spec
 * M10, decisions D-023, WS-2.4).
 *
 * One project per request (query param); envelopes carry the canonical fields
 * minus category (derived by Core from the event type — single source of
 * truth in shared). Task-lifecycle or transition-shaped payloads are rejected
 * with 400; per-envelope validation failures come back as `rejected` results
 * so a partial batch never silently drops events. Idempotency is by
 * event_id (D-023), not by an operation-level idempotency key.
 */
export async function registerIngestRoutes(server: FastifyInstance) {
  server.post(
    '/events',
    { preHandler: [validateQuery(ingestQuerySchema), validateBody(ingestBatchSchema)] },
    async (request) => {
      const { project_id } = request.query as z.infer<typeof ingestQuerySchema>;
      const body = request.body as IngestBatchInput;

      // Ledger-only contract (D-023): request-level 400 when any envelope
      // tries to smuggle a task-lifecycle/transition-shaped event in.
      const offending = [
        ...new Set(body.events.filter((e) => !isIngestibleType(e.type)).map((e) => e.type)),
      ];
      if (offending.length > 0) {
        throw new ValidationError(
          `Ledger-only ingestion: these event types are not ingestible: ${offending.join(', ')}. ` +
            'Task lifecycle and transition events are recorded by Core only.',
        );
      }

      // Unknown/unavailable project -> NotFoundError from the resolver.
      const db = server.projectDbs.forProject(project_id);
      return new IngestService(db, project_id).ingest(body.events);
    },
  );
}
