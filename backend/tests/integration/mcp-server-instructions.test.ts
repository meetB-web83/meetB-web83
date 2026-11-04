import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, type Config } from '@workjournal/core';
import { createMcpHttpServer } from '../../packages/mcp-adapter/src/http-server.js';
import { loadAdapterConfig, type AdapterConfig } from '../../packages/mcp-adapter/src/config.js';
import { MCP_SERVER_INSTRUCTIONS } from '../../packages/mcp-adapter/src/server-factory.js';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';

/**
 * MCP server instructions tests:
 * (a) the instructions string is <= 1,800 characters
 * (b) every tool name and parameter name it mentions exists in tools/list + schemas
 * (c) it is present in the initialize result over HTTP (and over stdio, see mcp-stdio.test.ts)
 */

const INSTRUCTION_TOKENS = Math.ceil(MCP_SERVER_INSTRUCTIONS.length / 4);

const TOOL_NAMES_MENTIONED = [
  'start_session',
  'list_tasks',
  'create_task',
  'update_task',
  'checkpoint',
  'record_decision',
  'get_resume_context',
];

/** Parameter names referenced as assignments in the instructions text. */
const PARAM_NAMES_MENTIONED = [
  'task_id',
  'claim',
  'status',
  'done',
  'findings',
  'issues',
  'next_steps',
  'rationale',
  'supersedes',
  'objective',
  'acceptance',
];

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function rawRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
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

describe('MCP server instructions', () => {
  it('(a) instructions string is <= 1,800 characters (~300-400 tokens)', () => {
    // eslint-disable-next-line no-console
    console.log(
      `MCP_SERVER_INSTRUCTIONS: ${MCP_SERVER_INSTRUCTIONS.length} chars, ~${INSTRUCTION_TOKENS} tokens`,
    );
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1_800);
  });

  describe('(b) + (c) over Streamable HTTP', () => {
    let core: ReturnType<typeof buildServer>;
    let corePort: number;
    let adapter: Server;
    let adapterPort: number;
    let registry: { db: unknown; dir: string; cleanup: () => void };
    let projectId: string;

    const coreUrl = () => `http://127.0.0.1:${corePort}`;
    const mcpUrl = () => `http://127.0.0.1:${adapterPort}/mcp`;

    beforeAll(async () => {
      registry = createRegistryDb();
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

      const adapterConfig: AdapterConfig = {
        ...loadAdapterConfig({ WORKJOURNAL_TOOLS: 'core' } as NodeJS.ProcessEnv),
        transport: 'http',
        coreUrl: coreUrl(),
      };
      adapter = createMcpHttpServer(adapterConfig);
      adapterPort = await listen(adapter);
      adapterConfig.allowedHosts.push(`127.0.0.1:${adapterPort}`);
      adapterConfig.allowedOrigins.push(`http://127.0.0.1:${adapterPort}`);

      const res = await fetch(`${coreUrl()}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'McpInstructions',
          root_path: tempProjectRoot(),
          idempotency_key: 'mcp-instructions-proj-001',
        }),
      });
      expect(res.status).toBe(201);
      projectId = (await res.json()).id;
    }, 30_000);

    afterAll(async () => {
      await new Promise((resolve) => adapter.close(resolve));
      await core.close();
      registry.cleanup();
    });

    it('(b) every mentioned tool name and parameter name exists in tools/list + schemas', async () => {
      const client = new Client({ name: 'mcp-instructions-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl())));
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        for (const name of TOOL_NAMES_MENTIONED) {
          expect(names).toContain(name);
        }
        const allProperties = new Set<string>();
        for (const tool of tools) {
          const props = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
          for (const key of Object.keys(props)) allProperties.add(key);
        }
        for (const param of PARAM_NAMES_MENTIONED) {
          expect(allProperties).toContain(param);
        }
      } finally {
        await client.close();
      }
    }, 30_000);

    it('(c) instructions present in the initialize result over HTTP', async () => {
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
      // The Streamable HTTP transport frames the initialize response as SSE:
      // one or more "data: <json>" lines. Extract the JSON payload.
      const dataLine = res.body.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse(dataLine!.slice('data: '.length));
      expect(parsed.result?.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
    });
  });
});
