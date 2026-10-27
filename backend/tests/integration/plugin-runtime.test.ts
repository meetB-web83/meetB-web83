/**
 * Embedded plugin runtime tests (D-022, D-026).
 *
 * Both lifecycle plugins scope events by matching the session workspace
 * against Core's registered project roots. Real registries can hold the
 * git-bash form (`/c/Users/...`) while the agent reports `C:\Users\...`, so
 * the plugins must canonicalize before comparing — otherwise every event is
 * silently dropped. These tests load the exact embedded sources that
 * `workjournal setup` writes and drive them with a stubbed Core.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clinePluginSource } from '../../packages/cli/src/integrations/adapters/cline/plugin.generated.js';
import { opencodePluginSource } from '../../packages/cli/src/integrations/adapters/opencode/plugin.generated.js';

const GIT_BASH_ROOT = '/c/Users/me/Projects/WorkJournal';
const NATIVE_ROOT = 'C:\\Users\\me\\Projects\\WorkJournal';
const PROJECT = { id: 'wj-project', name: 'WorkJournal', root_path: GIT_BASH_ROOT };

interface IngestCall {
  url: string;
  events: Array<{ type: string; source: string; payload: Record<string, unknown> }>;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKJOURNAL_CORE_URL;
  vi.restoreAllMocks();
});

function stubCore(projects: unknown[]): IngestCall[] {
  const calls: IngestCall[] = [];
  process.env.WORKJOURNAL_CORE_URL = 'http://core.test';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://core.test/api/projects?available=true') {
      return new Response(JSON.stringify(projects), { status: 200 });
    }
    if (url.startsWith('http://core.test/api/ingest/events')) {
      calls.push({ url, events: JSON.parse(String(init?.body)).events });
      return new Response(JSON.stringify({ results: [], accepted: 0, duplicates: 0, rejected: 0 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function loadPlugin(source: string): Promise<Record<string, any>> {
  // A unique trailing comment makes each import a distinct module URL, so
  // module-level state (queue, dedupe sets) never leaks between tests.
  const unique = `${source}\n// test-${Math.random()}\n`;
  const encoded = Buffer.from(unique, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe('cline lifecycle plugin', () => {
  it('matches a git-bash registered root against the native workspace path', async () => {
    const calls = stubCore([PROJECT]);
    const plugin = await loadPlugin(clinePluginSource);

    plugin.setup({}, { workspaceInfo: { rootPath: NATIVE_ROOT } });
    await plugin.hooks.onEvent({
      type: 'run-started',
      snapshot: { conversationId: 'conv-1', runId: 'run-1', status: 'running' },
    });
    await plugin.hooks.onEvent({
      type: 'run-finished',
      snapshot: { conversationId: 'conv-1', runId: 'run-1', status: 'completed' },
      result: { status: 'completed' },
    });
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('project_id=wj-project');
    expect(calls[0].events.map((e) => e.type)).toEqual([
      'agent_session_started',
      'agent_session_ended',
    ]);
    expect(calls[0].events[1].payload.reason).toBe('completed');
  });

  it('records each tool call with a redacted target and attaches the run summary', async () => {
    const calls = stubCore([PROJECT]);
    const plugin = await loadPlugin(clinePluginSource);

    plugin.setup({}, { workspaceInfo: { rootPath: NATIVE_ROOT } });
    await plugin.hooks.onEvent({
      type: 'run-started',
      snapshot: { conversationId: 'conv-3', runId: 'run-3', status: 'running' },
    });
    const snapshot = { conversationId: 'conv-3', runId: 'run-3', status: 'running' };
    await plugin.hooks.afterTool({
      snapshot,
      tool: { name: 'write_to_file' },
      toolCall: { toolCallId: 'call-1', toolName: 'write_to_file', input: { path: 'src/app.ts' } },
      input: { path: 'src/app.ts' },
      result: { output: 'ok' },
      durationMs: 12,
    });
    await plugin.hooks.afterTool({
      snapshot,
      tool: { name: 'execute_command' },
      toolCall: {
        toolCallId: 'call-2',
        toolName: 'execute_command',
        input: { command: 'mysql --password=hunter2 -e "select 1"' },
      },
      input: { command: 'export API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456; npm test' },
      result: { output: 'boom', isError: true },
      durationMs: 31,
    });
    await plugin.hooks.onEvent({
      type: 'run-finished',
      snapshot: { conversationId: 'conv-3', runId: 'run-3', status: 'completed' },
      result: {
        status: 'completed',
        iterations: 4,
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
    await settle();

    const events = calls.flatMap((call) => call.events);
    const tools = events.filter((e) => e.type === 'agent_tool_call');
    expect(tools).toHaveLength(2);
    expect(tools[0].payload).toMatchObject({
      tool: 'write_to_file',
      status: 'succeeded',
      target: 'src/app.ts',
      duration_ms: 12,
      tool_call_id: 'call-1',
    });
    expect(tools[1].payload).toMatchObject({
      tool: 'execute_command',
      status: 'failed',
      duration_ms: 31,
      tool_call_id: 'call-2',
    });
    expect(String(tools[1].payload.target)).not.toContain('hunter2');
    expect(String(tools[1].payload.target)).toContain('[REDACTED]');

    const ended = events.find((e) => e.type === 'agent_session_ended');
    expect(ended?.payload).toMatchObject({
      reason: 'completed',
      iterations: 4,
      tool_call_count: 2,
      failed_tool_call_count: 1,
      files_touched: ['src/app.ts'],
      input_tokens: 100,
      output_tokens: 20,
    });
  });

  it('reports unmatched workspaces instead of dropping them silently', async () => {
    stubCore([PROJECT]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await loadPlugin(clinePluginSource);

    plugin.setup({}, { workspaceInfo: { rootPath: 'C:\\somewhere\\else' } });
    await plugin.hooks.onEvent({
      type: 'run-started',
      snapshot: { conversationId: 'conv-2', runId: 'run-2', status: 'running' },
    });
    await settle();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no registered project matches'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registered roots:'));
  });
});

describe('opencode lifecycle plugin', () => {
  it('matches a git-bash registered root against the native workspace path', async () => {
    const calls = stubCore([PROJECT]);
    const plugin = await loadPlugin(opencodePluginSource);

    const queue: Array<Record<string, any>> = [];
    const abort = new AbortController();
    const ctx = {
      location: { directory: NATIVE_ROOT },
      event: {
        async *subscribe() {
          while (!abort.signal.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      },
    };

    const teardown = await plugin.setup(ctx);
    queue.push({ type: 'session.created', data: { sessionID: 'ses-1' } });
    queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses-1' } });
    await settle();
    abort.abort();
    await teardown();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('project_id=wj-project');
    expect(calls[0].events.map((e) => e.type)).toEqual([
      'agent_session_started',
      'agent_session_ended',
    ]);
  });
});
