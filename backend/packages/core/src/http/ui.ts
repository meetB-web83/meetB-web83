import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UiAssets } from '../ui/ui-assets.js';

/**
 * Serves the dashboard from an in-memory UiAssets set on the SAME origin as
 * the API. Replaces both the `vite preview` web container and the dev proxy:
 * the SPA's relative `/api/*` fetches hit the core service directly.
 *
 * Route rules:
 *  - exact asset match  → the asset (hashed `/assets/*` get immutable caching,
 *    everything else revalidates every load)
 *  - `/api/*`, `/health` misses → JSON 404 (the API contract; never HTML)
 *  - any other GET      → index.html (SPA client-side routing fallback)
 *  - non-GET/HEAD on unknown paths → JSON 404
 *
 * Registered only when the server was built with UI assets; without it the
 * core service is API-only exactly as before.
 */
export function registerUiRoutes(server: FastifyInstance, ui: UiAssets): void {
  const sendAsset = (reply: FastifyReply, path: string): FastifyReply => {
    const asset = ui.files[path];
    if (!asset) return sendIndex(reply);
    reply.header('Content-Type', asset.contentType);
    reply.header(
      'Cache-Control',
      path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    return reply.send(Buffer.from(asset.base64, 'base64'));
  };

  const sendIndex = (reply: FastifyReply): FastifyReply => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(ui.indexHtml);
  };

  const api404 = (reply: FastifyReply, request: FastifyRequest): FastifyReply =>
    reply.status(404).send({
      error: 'NOT_FOUND',
      message: `Route ${request.method}:${request.url} not found`,
    });

  // Wildcard catch-all, lowest precedence behind the registered /api routes
  // and /health. `request.params['*']` is the unmatched remainder.
  server.get<{ Params: { '*': string } }>('/*', (request, reply) => {
    const path = request.params['*'] ?? '';
    if (path.startsWith('api/') || path === 'api' || path === 'health') {
      return api404(reply, request);
    }
    if (ui.files[path]) return sendAsset(reply, path);
    // Unknown file-looking path (e.g. /assets/gone.js): 404, not HTML — the
    // browser must see a real miss for stale bundles. Everything else is a
    // client-side route → index.html.
    if (path.includes('/') && /\.[a-z0-9]+$/i.test(path)) {
      return api404(reply, request);
    }
    return sendIndex(reply);
  });

  // Explicit root route: `/*` also matches "/", but serving index.html through
  // the wildcard would compute path="" — handle it directly for clarity.
  server.get('/', (_request, reply) => sendIndex(reply));
}
