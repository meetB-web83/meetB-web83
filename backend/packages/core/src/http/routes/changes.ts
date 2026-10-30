import type { FastifyInstance } from 'fastify';
import type { CoreServices } from '../services.js';
import { ChangeBus, type PromptChangeEvent } from '../../domain/change-bus.js';

/**
 * SSE stream of prompt change events.
 *
 * Clients (MCP adapter) connect here to receive real-time notifications when
 * prompts are created, updated, deleted, or toggled. The adapter then re-syncs
 * its prompt registry and sends `prompts/list_changed` to connected MCP clients.
 *
 * Connection lifecycle:
 *   Client connects → server holds the connection open → server sends
 *   `data:` lines for each change → client may disconnect at any time.
 *
 * Reconnection: clients should send `Last-Event-ID` with the last event id they
 * received; the server will replay missed events from its in-memory buffer.
 *
 * Registered directly on the main server (not via server.register with a prefix)
 * because Fastify encapsulates /api/* paths when plugins with /api/* prefixes
 * are registered, which prevents direct /api/... routes from matching.
 */
export function registerChangesRoutes(
  server: FastifyInstance,
  services: CoreServices,
  changeBus: ChangeBus,
): void {
  // In-memory buffer of recent events for reconnection replay.
  const eventBuffer: Array<{ id: string; event: PromptChangeEvent }> = [];
  const MAX_BUFFER = 1000;
  let seq = 0;

  server.get('/changes/stream', async (request, reply) => {
    reply.header('Content-Type', 'text/event-stream');
    reply.header('Cache-Control', 'no-cache');
    reply.header('Connection', 'keep-alive');
    reply.header('X-Accel-Buffering', 'no');

    const lastEventId = request.headers['last-event-id'] as string | undefined;
    const clientId = String(++seq);

    // Replay missed events from the buffer.
    let startIndex = 0;
    if (lastEventId) {
      const lastIdx = eventBuffer.findIndex((e) => e.id === lastEventId);
      if (lastIdx !== -1) startIndex = lastIdx + 1;
    }
    for (let i = startIndex; i < eventBuffer.length; i++) {
      const { id, event } = eventBuffer[i];
      reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    const handlerId = changeBus.subscribe((event) => {
      const id = String(++seq);
      eventBuffer.push({ id, event });
      if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();
      reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat to keep the connection alive through proxies.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        // Client likely disconnected
      }
    }, 30000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      changeBus.unsubscribe(handlerId);
    });

    // Don't end the response — keep the SSE connection open.
    return reply.send();
  });
}
