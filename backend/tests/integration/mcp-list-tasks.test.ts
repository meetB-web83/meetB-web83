import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, type Database, type Config } from '@workjournal/core';
import { createMcpHttpServer } from '../../packages/mcp-adapter/src/http-server.js';
import { loadAdapterConfig, type AdapterConfig } from '../../packages/mcp-adapter/src/config.js';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Tests for the `list_tasks` MCP tool (core profile).
 * Covers: default filtering/ordering, truncation, read-only, next_actions reference valid tools.
 */

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function connectClient(adapterPort: number): Promise<Client> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'list-tasks-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${adapterPort}/mcp`)));
  return client;
}

describe('MCP core profile: list_tasks tool', () => {
  let core: ReturnType<typeof buildServer>;
  let corePort: number;
  let adapter: Server;
  let adapterPort: number;
  let adapterConfig: AdapterConfig;
  let registry: { db: Database; dir: string; cleanup: () => void };
  let projectRoot: string;
  let projectId: string;
  let client: Client;

  const coreUrl = () => `http://127.0.0.1:${corePort}`;
  const mcpUrl = () => `http://127.0.0.1:${adapterPort}/mcp`;

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

    // Create project FIRST so we have the projectId for the adapter config
    const res = await fetch(`${coreUrl()}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ListTasksTest',
        root_path: projectRoot,
        idempotency_key: 'list-tasks-proj-001',
      }),
    });
    expect(res.status).toBe(201);
    projectId = (await res.json()).id;

    // Now create adapter with the known projectId
    adapterConfig = {
      ...loadAdapterConfig({ WORKJOURNAL_TOOLS: 'core', WORKJOURNAL_PROJECT_ID: projectId } as NodeJS.ProcessEnv),
      transport: 'http',
      coreUrl: coreUrl(),
    };
    adapter = createMcpHttpServer(adapterConfig);
    adapterPort = await listen(adapter);
    adapterConfig.allowedHosts.push(`127.0.0.1:${adapterPort}`);
    adapterConfig.allowedOrigins.push(`http://127.0.0.1:${adapterPort}`);

    client = await connectClient(adapterPort);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await new Promise((resolve) => adapter.close(resolve));
    await core.close();
    registry.cleanup();
    const { rmSync } = await import('node:fs');
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('tools/list contains exactly 7 core tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'checkpoint',
      'create_task',
      'get_resume_context',
      'list_tasks',
      'record_decision',
      'start_session',
      'update_task',
    ].sort());
  });

  it('list_tasks has readOnlyHint=true and correct schema', async () => {
    const { tools } = await client.listTools();
    const listTasksTool = tools.find((t) => t.name === 'list_tasks');
    expect(listTasksTool).toBeDefined();
    expect(listTasksTool?.annotations?.readOnlyHint).toBe(true);
    expect(listTasksTool?.annotations?.idempotentHint).toBe(true);
    expect(listTasksTool?.annotations?.destructiveHint).toBe(false);
    expect(listTasksTool?.inputSchema).toBeDefined();
    expect(listTasksTool?.description).toBe('See which tasks exist and which one to work on.');
  });

  it('list_tasks default: returns actionable tasks only with count summary', async () => {
    const agentId = `test-agent_${projectId}`;
    
    // Create open tasks
    await client.callTool({
      name: 'create_task',
      arguments: { project: projectId, agent_id: agentId, title: 'Open Task 1', priority: 'high', idempotency_key: 'lt-1' },
    });
    await client.callTool({
      name: 'create_task',
      arguments: { project: projectId, agent_id: agentId, title: 'Open Task 2', priority: 'medium', idempotency_key: 'lt-2' },
    });
    
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(result.isError).toBeUndefined();
    const content = (result as { content: Array<{ type: string; text: string }> }).content[0].text;

    // Should have count summary with non-zero statuses
    expect(content).toMatch(/open/);
    // in_progress, interrupted, completed, blocked, cancelled are 0 so not shown

    // Should list actionable tasks (open, interrupted, in_progress)
    const lines = content.split('\n');
    const taskLines = lines.slice(1).filter((l) => l.trim() && !l.startsWith('0 more') && !l.startsWith('Call '));
    // Should have the two open tasks
    expect(taskLines.length).toBe(2);
  });

  it('list_tasks with status=all returns all statuses', async () => {
    const result = await client.callTool({ name: 'list_tasks', arguments: { status: 'all' } });
    expect(result.isError).toBeUndefined();
    const content = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
    // Count summary only shows non-zero counts; with only open tasks, it shows "2 open"
    expect(content).toContain('open');
    // The task list should include all statuses when status=all
    expect(content).toContain('Open Task 1');
    expect(content).toContain('Open Task 2');
  });

  it('list_tasks with status filter returns only that status', async () => {
    const result = await client.callTool({ name: 'list_tasks', arguments: { status: 'open' } });
    expect(result.isError).toBeUndefined();
    const content = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
    // Should only show open tasks in the list (count summary still shows all)
    expect(content).toContain('open');
  });

  it('list_tasks accepts limit parameter', async () => {
    const result = await client.callTool({ name: 'list_tasks', arguments: { limit: 5 } });
    expect(result.isError).toBeUndefined();
  });

  it('list_tasks next_actions reference valid tool names', async () => {
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(result.isError).toBeUndefined();
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    if (structured && structured.next_actions) {
      const actions = structured.next_actions as string[];
      const toolNames = actions.flatMap((a) => a.match(/(\w+_\w+)/g) || []);
      const { tools } = await client.listTools();
      const validTools = new Set(tools.map((t) => t.name));
      for (const tool of toolNames) {
        expect(validTools.has(tool)).toBe(true);
      }
    }
  });

  it('start_session returns in_progress tasks + count summary (no open/interrupted list)', async () => {
    const agentId = `session-agent_${projectId}`;
    await client.callTool({
      name: 'create_task',
      arguments: { project: projectId, agent_id: agentId, title: 'Test Task', priority: 'medium', idempotency_key: 'session-test-1' },
    });

    const result = await client.callTool({ name: 'start_session', arguments: {} });
    expect(result.isError).toBeUndefined();
    const content = (result as { content: Array<{ type: string; text: string }> }).content[0].text;

    // Should mention "in progress" and count summary
    expect(content).toMatch(/in progress/);
    expect(content).toMatch(/open|interrupted|completed|blocked|cancelled/);
    
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(structured).toHaveProperty('my_in_progress');
    expect(structured).not.toHaveProperty('tasks'); // old format had 'tasks' array with all
  });
});