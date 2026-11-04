import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/register.js';
import { syncPrompts } from './prompts/registry.js';
import { ToolProfile } from './config.js';
import { createLogger, LOG_FILE } from '@workjournal/shared';

let _mcpLogger: ReturnType<typeof createLogger> | null = null;
/** Lazily-created logger so importing this module does not create a pino
 *  destination (and register a SonicBoom exit handler) until first use. */
const mcpLogger = new Proxy({} as ReturnType<typeof createLogger>, {
  get(_, prop: string) {
    if (!_mcpLogger) _mcpLogger = createLogger({ component: 'mcp-adapter', module: 'server-factory' });
    return Reflect.get(_mcpLogger, prop);
  },
}) as ReturnType<typeof createLogger>;

/**
 * MCP server instructions sent to every client (stdio and Streamable HTTP)
 * in the initialize result. Plain text, no markdown tables or code fences.
 * Owns only the order of steps and the rules between tools — parameter
 * documentation lives in each tool's inputSchema description.
 * Every tool name and parameter name mentioned here must exist in the
 * registered core-tool schemas.
 */
export const MCP_SERVER_INSTRUCTIONS = `WorkJournal keeps task progress across agent sessions so another agent can continue without the original conversation. Use it for any multi-step coding work, before you edit files.

Flow:
1. Start: call start_session. To browse tasks, call list_tasks. If a task for this work is in_progress or interrupted, resume it with start_session(task_id, claim=true); the brief shows where it stopped.
2. New work: create_task with a clear objective and acceptance criteria, then update_task(status="in_progress") to claim it before editing anything. create_task does not claim by itself. If you already have several tasks planned, call create_task for each one up front so you don't need to keep track of what to do next.
3. While working: after each meaningful step (a feature works, a bug is diagnosed, tests pass) call checkpoint with done, findings, issues and next_steps.
4. Choices others must follow: record_decision with the rationale. To replace an earlier one, pass supersedes.
5. Scope changes or new acceptance criteria: update_task with the new objective or criteria.
6. Before you stop, or if you are stuck: checkpoint first, then update_task with status="blocked" or "interrupted" and a reason.
7. When the acceptance criteria are met: update_task(status="completed").
8. After your context is compacted or you lose track: get_resume_context.

Rules: one task at a time; never edit files for a task you have not claimed; never invent ids, use the ones returned; if a call fails, the error says how to fix it.`;

/**
 * Single place where the MCP server is created and tools are registered, so
 * stdio and Streamable HTTP transports always expose identical tool names,
 * descriptions, schemas and handlers (root AGENTS.md: shared Zod schemas are
 * the single contract).
 *
 * The MCP adapter subscribes to Core's SSE change stream at
 * /changes/stream. When a prompt is created, updated, deleted or toggled,
 * the adapter re-syncs its prompt registry and sends
 * prompts/list_changed to connected MCP clients so they pick up the new
 * templates without restarting the adapter.
 */
export async function createMcpServer(
  coreUrl: string,
  projectId?: string,
  toolProfile: ToolProfile = 'core',
): Promise<McpServer> {
  mcpLogger.info({ coreUrl, logFile: LOG_FILE, projectId: projectId ?? null, toolProfile }, 'creating MCP server');
  const server = new McpServer(
    { name: 'workjournal', version: '0.1.0' },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerTools(server, coreUrl, projectId, toolProfile);

  // The `prompts` capability must be registered BEFORE connect() and BEFORE
  // syncPrompts, because capabilities cannot be added after connect().
  // Later registerPrompt() calls would throw if this is missing.
  // Only register prompts capability for 'full' profile (which includes all built-in prompts).
  if (toolProfile === 'full') {
    server.server.registerCapabilities({ prompts: { listChanged: true } });

    try {
      const registered = await syncPrompts(server, coreUrl, projectId ?? process.env.WORKJOURNAL_PROJECT_ID);
      mcpLogger.info(
        {
          coreUrl,
          projectId: process.env.WORKJOURNAL_PROJECT_ID || null,
          promptCount: registered.size,
        },
        'prompt registry synced',
      );
    } catch (err) {
      mcpLogger.error({ coreUrl, error: String(err) }, 'failed to sync prompt registry on startup');
    }

    // Subscribe to prompt change notifications via SSE.
    // Runs in the background; errors are logged but don't block server startup.
    void subscribeToPromptChanges(server, coreUrl);
  }

  return server;
}

/**
 * Re-sync the prompt registry from Core and notify MCP clients.
 * Always runs in its own try/catch — errors are logged, never swallowed.
 */
async function resyncAndNotify(server: McpServer, coreUrl: string): Promise<void> {
  try {
    await syncPrompts(server, coreUrl, process.env.WORKJOURNAL_PROJECT_ID);
    server.sendPromptListChanged();
  } catch (err) {
    mcpLogger.error(
      { component: 'mcp-adapter', module: 'server-factory', error: String(err) },
      'resyncAndNotify failed',
    );
  }
}

/**
 * Opens an SSE connection to Core's /changes/stream and re-syncs prompts
 * whenever a change notification arrives. Reconnects automatically on failure.
 *
 * An AbortController is wired to server.server.onclose so the loop stops when
 * the MCP server/transport closes, avoiding a leaked never-ending loop per
 * server instance (important for HTTP transport where each session has its own
 * McpServer).
 */
async function subscribeToPromptChanges(server: McpServer, coreUrl: string): Promise<void> {
  const abortController = new AbortController();

  // Stop the loop when the MCP server/transport closes.
  server.server.onclose = () => {
    mcpLogger.info(
      { component: 'mcp-adapter', module: 'server-factory' },
      'MCP server closed — stopping change stream loop',
    );
    abortController.abort();
  };

  let reconnectMs = 1000;
  const maxReconnectMs = 30_000;

  while (!abortController.signal.aborted) {
    let res: Response;
    try {
      res = await fetch(`${coreUrl}/changes/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: abortController.signal,
      });
    } catch (err) {
      if (abortController.signal.aborted) break;
      mcpLogger.error(
        { component: 'mcp-adapter', module: 'server-factory', error: String(err) },
        'changes stream connect error — reconnecting',
      );
      await sleepOrAbort(reconnectMs, abortController.signal);
      if (abortController.signal.aborted) break;
      reconnectMs = Math.min(reconnectMs * 2, maxReconnectMs);
      continue;
    }

    if (!res.ok || !res.body) {
      try {
        res.body?.cancel();
      } catch {
        // Ignore cancel errors.
      }
      if (abortController.signal.aborted) break;
      mcpLogger.warn(
        { component: 'mcp-adapter', module: 'server-factory', status: res.status },
        'changes stream returned non-OK — reconnecting',
      );
      await sleepOrAbort(reconnectMs, abortController.signal);
      if (abortController.signal.aborted) break;
      reconnectMs = Math.min(reconnectMs * 2, maxReconnectMs);
      continue;
    }

    // Successful connection: reset backoff and log.
    reconnectMs = 1000;
    mcpLogger.info({ component: 'mcp-adapter', module: 'server-factory' }, 'change stream connected');

    // Catch up on any events missed while disconnected.
    await resyncAndNotify(server, coreUrl);
    if (abortController.signal.aborted) break;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          // Reader done = core closed the stream. Treat as a disconnect.
          mcpLogger.warn(
            { component: 'mcp-adapter', module: 'server-factory' },
            'change stream closed by core',
          );
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (abortController.signal.aborted) break;

          // SSE framing: ignore comments and id: lines, only process data:.
          if (line.startsWith(':') || line.startsWith('id:')) continue;
          if (!line.startsWith('data: ')) continue;

          const payload = line.slice(6);
          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            // Malformed event data — skip this line.
            continue;
          }

          // Skip non-prompt events.
          if (event.type !== 'prompt') continue;

          // Scope events: if a projectId is set and it differs from the
          // adapter's configured project, skip the resync. When no project
          // id is configured the adapter loads only global prompts.
          const projectId = process.env.WORKJOURNAL_PROJECT_ID;
          if (event.projectId !== null && event.projectId !== undefined && projectId && event.projectId !== projectId) {
            continue;
          }

          await resyncAndNotify(server, coreUrl);
          if (abortController.signal.aborted) break;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore.
      }
    }

    // Stream ended (closed by core or error). Always back off before reconnecting.
    if (abortController.signal.aborted) break;
    mcpLogger.warn(
      { component: 'mcp-adapter', module: 'server-factory' },
      'change stream ended — reconnecting',
    );
    await sleepOrAbort(reconnectMs, abortController.signal);
    if (abortController.signal.aborted) break;
    reconnectMs = Math.min(reconnectMs * 2, maxReconnectMs);
  }
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
