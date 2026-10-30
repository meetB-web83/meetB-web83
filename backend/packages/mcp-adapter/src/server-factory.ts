import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/register.js';
import { syncPrompts, getRegisteredNames } from './prompts/registry.js';
import { createLogger } from '@workjournal/shared';

const mcpLogger = createLogger({ component: 'mcp-adapter', module: 'server-factory' });

/**
 * Single place where the MCP server is created and tools are registered, so
 * stdio and Streamable HTTP transports always expose identical tool names,
 * descriptions, schemas and handlers (root AGENTS.md: shared Zod schemas are
 * the single contract).
 *
 * The MCP adapter subscribes to Core's SSE change stream at
 * /api/changes/stream. When a prompt is created, updated, deleted or toggled,
 * the adapter re-syncs its prompt registry and sends
 * prompts/list_changed to connected MCP clients so they pick up the new
 * templates without restarting the adapter.
 */
export async function createMcpServer(coreUrl: string): Promise<McpServer> {
  mcpLogger.info({ coreUrl }, 'creating MCP server');
  const server = new McpServer({
    name: 'workjournal',
    version: '0.1.0',
  });
  registerTools(server, coreUrl);

  try {
    const registered = await syncPrompts(server, coreUrl, process.env.WORKJOURNAL_PROJECT_ID);
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

  return server;
}

/**
 * Opens an SSE connection to Core's /api/changes/stream and re-syncs prompts
 * whenever a change notification arrives. Reconnects automatically on failure.
 */
async function subscribeToPromptChanges(server: McpServer, coreUrl: string): Promise<void> {
  let reconnectMs = 1000;
  const maxReconnectMs = 30000;

  while (true) {
    try {
      const res = await fetch(`${coreUrl}/api/changes/stream`, {
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok || !res.body) {
        throw new Error(`Changes stream returned ${res.status}`);
      }

      reconnectMs = 1000; // reset backoff on successful connection
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            try {
              const event = JSON.parse(payload);
              if (event.type === 'prompt') {
                await syncPrompts(server, coreUrl, process.env.WORKJOURNAL_PROJECT_ID);
                server.sendPromptListChanged();
              }
            } catch {
              // Malformed event data — skip
            }
          }
        }
      }
    } catch (err) {
      // Connection error — back off and retry
      mcpLogger.error(
        { component: 'mcp-adapter', module: 'server-factory', error: String(err) },
        'changes stream error — reconnecting',
      );
      await new Promise((resolve) => setTimeout(resolve, reconnectMs));
      reconnectMs = Math.min(reconnectMs * 2, maxReconnectMs);
    }
  }
}
