import type { FastifyInstance } from 'fastify';
import { WorkJournalError } from '@workjournal/shared';

export async function registerErrorHandler(server: FastifyInstance) {
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkJournalError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
    });
  });
}
