import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/register.js';

const CORE_SERVICE_URL = process.env.WORKJOURNAL_CORE_URL || 'http://127.0.0.1:3737';

const server = new McpServer({
  name: 'workjournal',
  version: '0.1.0',
});

registerTools(server, CORE_SERVICE_URL);

const transport = new StdioServerTransport();
await server.connect(transport);
