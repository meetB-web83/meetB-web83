import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/register.js';
import { syncPrompts } from './prompts/registry.js';
import { createLogger, child } from '@workjournal/shared';

const mcpLogger = createLogger({ component: 'mcp-adapter', module: 'server-factory' });

/**
 * Single place where the MCP server is created and tools are registered, so
 * stdio and Streamable HTTP transports always expose identical tool names,
 * descriptions, schemas and handlers (root AGENTS.md: shared Zod schemas are
 * the single contract).
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

  return server;
}
