import type { FastifyInstance } from 'fastify';
import type { CoreServices } from '../services.js';
import { ChangeBus, type PromptChangeEvent } from '../../domain/change-bus.js';
import type { ServerResponse } from 'node:http';

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
 * The ChangeBus is subscribed ONCE at registration time; every connected
 * client receives every event (`id: <seq>\ndata: <json>\n\n`). A client that
 * fails to write is dropped. A `: heartbeat\n\n` is sent every 20s per client.
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
  const clients = new Set<ServerResponse>();
  let seq = 0;

  // Subscribe to the ChangeBus ONCE at registration time and fan out to every
  // connected client. Dropping a client whose write throws keeps the fan-out
  // resilient to dead connections.
  changeBus.subscribe((event: PromptChangeEvent) => {
    const line = `id: ${String(++seq)}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(line);
      } catch {
        // Client likely disconnected — remove it.
        clients.delete(client);
      }
    }
  });

  server.get('/changes/stream', (request, reply) => {
    // Hijack the raw response so we control the HTTP stream ourselves. Fastify
    // must not call reply.send() (which would close the connection).
    reply.hijack();

    // Headers must be set via reply.raw.writeHead — reply.header() only takes
    // effect inside send(), which we never call.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Immediately acknowledge the connection so the client knows it's open.
    reply.raw.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        // Client likely disconnected — cleanup handles removal.
      }
    }, 20_000);

    const removeClient = (): void => {
      clearInterval(heartbeat);
      clients.delete(reply.raw);
      try {
        reply.raw.end();
      } catch {
        // Already ended.
      }
    };

    request.raw.on('close', removeClient);
    request.raw.on('error', removeClient);

    clients.add(reply.raw);
  });

  // End all open SSE responses on server close so `tsx watch` restarts and
  // shutdown do not hang.
  server.addHook('onClose', async () => {
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // Ignore — best effort.
      }
    }
    clients.clear();
  });
}
