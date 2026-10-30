import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory.js';
import { createLogger } from '@workjournal/shared';

const stdioLogger = createLogger({ component: 'mcp-adapter', module: 'stdio' });

/**
 * Native local-development transport. Nothing may be written to stdout here —
 * stdout carries the MCP JSON-RPC stream.
 */
export async function startStdioServer(coreUrl: string): Promise<void> {
  stdioLogger.info({ coreUrl }, 'connecting MCP server to stdio transport');
  const server = await createMcpServer(coreUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stdioLogger.info({ coreUrl }, 'MCP server connected to stdio transport');
}
