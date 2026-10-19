import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, type Database, type Config } from '@workjournal/core';
import { createMcpHttpServer } from '@workjournal/mcp-adapter/http-server';
import { loadAdapterConfig, type AdapterConfig } from '@workjournal/mcp-adapter/config';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';

/**
 * End-to-end Streamable HTTP MCP tests: a real core Fastify service on a
 * random port with a real (temp-dir) SQLite registry, and the real adapter
 * HTTP server on a random port. Covers initialization, tool discovery,
 * representative read/write tool calls, argument validation errors, session
 * handling, origin/host rejection and the optional bearer token.
 * Per project rules: real SQLite only, no DB mocks.
 */

const EXPECTED_TOOLS = [
  'block_task',
  'cancel_task',
  'claim_task',
  'complete_task',
  'create_task',
  'export_handoff',
  'get_dashboard',
  'get_resume_context',
  'get_task',
  'get_task_history',
  'list_tasks',
  'mark_task_interrupted',
  'record_checkpoint',
  'record_decision',
  'release_task',
  'supersede_decision',
  'unblock_task',
  'update_task',
].sort();

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** Raw HTTP request helper (fetch forbids overriding Host in some runtimes). */
function rawRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('MCP over Streamable HTTP', () => {
  let core: ReturnType<typeof buildServer>;
  let corePort: number;
  let adapter: Server;
  let adapterPort: number;
  let adapterConfig: AdapterConfig;
  let registry: { db: Database; dir: string; cleanup: () => void };
  let projectRoot: string;
  let projectId: string;

  const coreUrl = () => `http://127.0.0.1:${corePort}`;
  const mcpUrl = () => `http://127.0.0.1:${adapterPort}/mcp`;

  async function connectClient(): Promise<Client> {
    const client = new Client({ name: 'mcp-http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl())));
    return client;
  }

  beforeAll(async () => {
    registry = createRegistryDb();
    projectRoot = tempProjectRoot();
    const coreConfig: Config = {
      workjournalHome: registry.dir,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      nodeEnv: 'test',
    };
    core = buildServer(registry.db, coreConfig);
    await core.listen({ host: '127.0.0.1', port: 0 });
    corePort = (core.server.address() as AddressInfo).port;

    adapterConfig = {
      ...loadAdapterConfig({} as NodeJS.ProcessEnv),
      transport: 'http',
      coreUrl: coreUrl(),
    };
    adapter = createMcpHttpServer(adapterConfig);
    adapterPort = await listen(adapter);
    // Random test port: extend the default allowlists with the real port.
    adapterConfig.allowedHosts.push(`127.0.0.1:${adapterPort}`);
    adapterConfig.allowedOrigins.push(`http://127.0.0.1:${adapterPort}`);

    // Register a project through the core API (as the dashboard would).
    const res = await fetch(`${coreUrl()}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'McpHttp',
        root_path: projectRoot,
        idempotency_key: 'mcp-http-proj-001',
      }),
    });
    expect(res.status).toBe(201);
    projectId = (await res.json()).id;
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => adapter.close(resolve));
    await core.close();
    registry.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('serves /healthz without auth', async () => {
    const res = await rawRequest(adapterPort, { method: 'GET', path: '/healthz' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('initializes over Streamable HTTP and exposes all tools with input schemas', async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOLS);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect((tool.inputSchema as { type?: string }).type).toBe('object');
      }
      expect(tools.find((t) => t.name === 'create_task')?.description).toMatch(/idempotency_key/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('answers a raw initialize request with a session ID', async () => {
    const res = await rawRequest(adapterPort, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'raw-client', version: '0.0.1' },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeTruthy();
  });

  it('invokes a read tool (get_dashboard) through the core service', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: 'get_dashboard', arguments: {} });
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content[0].type).toBe('text');
      const payload = JSON.parse(content[0].text);
      expect(payload.stats).toBeDefined();
      expect(Array.isArray(payload.projects)).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('invokes write tools (create_task then get_task) and preserves business rules', async () => {
    const client = await connectClient();
    try {
      const created = await client.callTool({
        name: 'create_task',
        arguments: {
          project_id: projectId,
          agent_id: `agent-a_${projectId}`,
          title: 'Task created over HTTP MCP',
          idempotency_key: 'mcp-http-task-001',
        },
      });
      const task = JSON.parse(
        (created as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(task.id).toBeTruthy();
      expect(task.status).toBe('open');
      expect(task.version).toBe(1);

      const fetched = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } });
      const refetched = JSON.parse(
        (fetched as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(refetched.id).toBe(task.id);
      expect(refetched.title).toBe('Task created over HTTP MCP');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('returns a protocol error for invalid tool arguments', async () => {
    const client = await connectClient();
    try {
      // Missing required task_id: SDK schema validation rejects before the
      // handler and returns an MCP error result (not a crash).
      const result = await client.callTool({ name: 'get_task', arguments: {} });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toMatch(/task_id/i);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('rejects requests with an unknown session ID (404) and non-initialize requests without one (400)', async () => {
    const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

    const unknownSession = await rawRequest(adapterPort, {
      method: 'POST',
      path: '/mcp',
      headers: { ...headers, 'mcp-session-id': 'bogus-session' },
      body: listBody,
    });
    expect(unknownSession.status).toBe(404);

    const noSession = await rawRequest(adapterPort, {
      method: 'POST',
      path: '/mcp',
      headers,
      body: listBody,
    });
    expect(noSession.status).toBe(400);
  });

  it('rejects disallowed Origin headers (browser-origin abuse)', async () => {
    const res = await rawRequest(adapterPort, {
      method: 'POST',
      path: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Origin: 'http://evil.example',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
      },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('ORIGIN_REJECTED');
  });

  it('rejects disallowed Host headers (DNS rebinding)', async () => {
    const res = await rawRequest(adapterPort, {
      method: 'POST',
      path: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: 'attacker.example:3738',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
      },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('HOST_REJECTED');
  });

  it('enforces the optional bearer token when MCP_AUTH_TOKEN is configured', async () => {
    const tokenConfig: AdapterConfig = {
      ...adapterConfig,
      authToken: 'test-token-123',
      allowedHosts: [...adapterConfig.allowedHosts],
      allowedOrigins: [...adapterConfig.allowedOrigins],
    };
    const tokenAdapter = createMcpHttpServer(tokenConfig);
    const tokenPort = await listen(tokenAdapter);
    tokenConfig.allowedHosts.push(`127.0.0.1:${tokenPort}`);
    try {
      const health = await rawRequest(tokenPort, { method: 'GET', path: '/healthz' });
      expect(health.status).toBe(200);

      const unauthorized = await rawRequest(tokenPort, {
        method: 'POST',
        path: '/mcp',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
        },
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await rawRequest(tokenPort, {
        method: 'POST',
        path: '/mcp',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer test-token-123',
        },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
        },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await new Promise((resolve) => tokenAdapter.close(resolve));
    }
  }, 30_000);

  it('404s unknown paths', async () => {
    const res = await rawRequest(adapterPort, { method: 'GET', path: '/' });
    expect(res.status).toBe(404);
  });
});
