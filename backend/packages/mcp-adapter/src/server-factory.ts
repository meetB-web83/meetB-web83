import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/register.js';

/**
 * Single place where the MCP server is created and tools are registered, so
 * stdio and Streamable HTTP transports always expose identical tool names,
 * descriptions, schemas and handlers (root AGENTS.md: shared Zod schemas are
 * the single contract).
 */
export function createMcpServer(coreUrl: string): McpServer {
  const server = new McpServer({
    name: 'workjournal',
    version: '0.1.0',
  });
  registerTools(server, coreUrl);
  return server;
}
