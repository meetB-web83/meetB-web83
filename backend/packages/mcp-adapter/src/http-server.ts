import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AdapterConfig } from './config.js';
import { checkRequest } from './validate-headers.js';
import { createMcpServer } from './server-factory.js';

const MAX_BODY_BYTES = 1_048_576; // matches core's 1 MiB body limit

interface Session {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Streamable HTTP server for the MCP adapter.
 *
 * Uses the SDK's StreamableHTTPServerTransport with a small session registry:
 * each `initialize` request gets a fresh McpServer + transport pair keyed by
 * the generated session ID; subsequent requests are routed by the
 * `mcp-session-id` header. Unknown session IDs get 404 and non-initialize
 * requests without a session ID get 400, per the MCP Streamable HTTP spec.
 *
 * Security: every /mcp request passes Host/Origin validation (DNS-rebinding and
 * browser-origin protection) and an optional bearer token check. `/healthz` is
 * unauthenticated so container health checks work without credentials.
 */
export function createMcpHttpServer(config: AdapterConfig): Server {
  const sessions = new Map<string, Session>();

  return createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];

    if (path === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (path !== '/mcp') {
      sendJson(res, 404, { error: 'NOT_FOUND', message: 'Only /mcp and /healthz are served.' });
      return;
    }

    const check = checkRequest(
      {
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
      },
      config,
    );
    if (!check.ok) {
      if (check.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, check.status, { error: check.code, message: check.message });
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      let raw: Buffer;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (err: any) {
        const status = err?.message === 'BODY_TOO_LARGE' ? 413 : 400;
        sendJson(res, status, {
          error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
          message: status === 413 ? 'Request body exceeds 1 MiB.' : 'Could not read request body.',
        });
        return;
      }
      if (raw.length === 0) {
        sendJson(res, 400, { error: 'BAD_REQUEST', message: 'Empty request body.' });
        return;
      }
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
        return;
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(body)) {
      const mcp = createMcpServer(config.coreUrl);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, mcp });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (sessionId) {
      sendJson(res, 404, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found. Re-initialize with the MCP client.' },
        id: null,
      });
      return;
    }

    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no session ID provided.' },
      id: null,
    });
  });
}

/** Create and start the HTTP transport; logs to stderr only (stdout stays protocol-safe). */
export async function startHttpServer(config: AdapterConfig): Promise<Server> {
  const server = createMcpHttpServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpHost, () => resolve());
  });
  console.error(
    `WorkJournal MCP server (Streamable HTTP) listening on http://${config.httpHost}:${config.httpPort}/mcp`,
  );
  return server;
}
