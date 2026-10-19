import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory.js';

/**
 * Native local-development transport. Nothing may be written to stdout here —
 * stdout carries the MCP JSON-RPC stream.
 */
export async function startStdioServer(coreUrl: string): Promise<void> {
  const server = createMcpServer(coreUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
