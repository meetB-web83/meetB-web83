import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer, type Config } from '@workjournal/core';
import { syncPrompts, getRegisteredNames } from '../../packages/mcp-adapter/src/prompts/registry.js';
import { createRegistryDb } from '../helpers/registry-factory.js';

/**
 * Phase 6 test: syncPrompts handles delete + recreate with the same name,
 * deregisters removed prompts, and works when starting with zero prompts.
 */
describe('prompt registry sync (syncPrompts)', () => {
  let registry: ReturnType<typeof createRegistryDb>;
  let server: ReturnType<typeof buildServer>;
  let coreUrl: string;
  let mcp: McpServer;

  const config: Config = {
    workjournalHome: '~/.workjournal-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  beforeEach(async () => {
    registry = createRegistryDb();
    server = buildServer(registry.db, config);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('no core port');
    coreUrl = `http://127.0.0.1:${address.port}`;
    mcp = new McpServer({ name: 'test', version: '0.1.0' });
  });

  afterEach(async () => {
    await server.close();
    registry.cleanup();
  });

  const createPrompt = (name: string, template: string, key: string, projectId?: string) =>
    server.inject({
      method: 'POST',
      url: '/api/prompts',
      payload: { name, template, idempotency_key: key, project_id: projectId ?? null },
    });

  const deletePrompt = (id: string) =>
    server.inject({ method: 'DELETE', url: `/api/prompts/${id}` });

  const registeredNamesOnMcp = (): string[] => {
    const mcpAny = mcp as unknown as { _registeredPrompts?: Record<string, { remove?: () => void }> };
    return Object.keys(mcpAny._registeredPrompts ?? {});
  };

  const customPromptNames = (names: Set<string>): string[] => {
    // Built-ins: resume_task, create_checkpoint, record_decision, review_handoff
    const builtIns = new Set(['resume_task', 'create_checkpoint', 'record_decision', 'review_handoff']);
    return [...names].filter((n) => !builtIns.has(n));
  };

  it('starts with only built-ins and picks up a custom prompt created later', async () => {
    // Sync — should find the 4 built-ins, no custom prompts.
    const first = await syncPrompts(mcp, coreUrl, undefined);
    expect(customPromptNames(first)).toEqual([]);

    // Create a custom prompt.
    const res = await createPrompt('late_prompt', 'Hello {{name}}', 'late-001');
    expect(res.statusCode).toBe(201);

    // Sync again — should find the new custom prompt.
    const second = await syncPrompts(mcp, coreUrl, undefined);
    expect(customPromptNames(second)).toContain('late_prompt');
    expect(registeredNamesOnMcp()).toContain('late_prompt');
  });

  it('delete + recreate with same name removes old registration, registers new id', async () => {
    // Create prompt.
    const res1 = await createPrompt('same_name', 'template v1', 'recreate-001');
    expect(res1.statusCode).toBe(201);
    const id1 = res1.json().id;

    // Sync — registered.
    await syncPrompts(mcp, coreUrl, undefined);
    expect(getRegisteredNames(mcp).has('same_name')).toBe(true);

    // Delete it.
    const del = await deletePrompt(id1);
    expect(del.statusCode).toBe(204);

    // Sync — should be deregistered.
    await syncPrompts(mcp, coreUrl, undefined);
    expect(getRegisteredNames(mcp).has('same_name')).toBe(false);
    expect(registeredNamesOnMcp()).not.toContain('same_name');

    // Recreate with the same name — new id.
    const res2 = await createPrompt('same_name', 'template v2', 'recreate-002');
    expect(res2.statusCode).toBe(201);
    const id2 = res2.json().id;
    expect(id2).not.toBe(id1);

    // Sync — should re-register with the new id.
    await syncPrompts(mcp, coreUrl, undefined);
    expect(getRegisteredNames(mcp).has('same_name')).toBe(true);
    expect(registeredNamesOnMcp()).toContain('same_name');
  });

  it('removed prompt is deregistered', async () => {
    const res = await createPrompt('temp_prompt', 'bye', 'temp-001');
    expect(res.statusCode).toBe(201);
    const id = res.json().id;

    await syncPrompts(mcp, coreUrl, undefined);
    expect(getRegisteredNames(mcp).has('temp_prompt')).toBe(true);

    await deletePrompt(id);
    await syncPrompts(mcp, coreUrl, undefined);

    expect(getRegisteredNames(mcp).has('temp_prompt')).toBe(false);
    expect(registeredNamesOnMcp()).not.toContain('temp_prompt');
  });
});
