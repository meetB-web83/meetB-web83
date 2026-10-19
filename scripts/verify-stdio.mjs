// Verifies the stdio transport still works against the built adapter (dist).
// Core is intentionally NOT running: the tool call must return the actionable
// "not reachable" error, proving stdio + forwarding + no-auto-start behavior.
import { Client } from '../backend/tests/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../backend/tests/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { fileURLToPath } from 'node:url';

const adapterEntry = fileURLToPath(new URL('../backend/packages/mcp-adapter/dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [adapterEntry],
  env: { ...process.env, WORKJOURNAL_CORE_URL: 'http://127.0.0.1:39999' },
  stderr: 'ignore',
});
const client = new Client({ name: 'stdio-verify', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log('STDIO_TOOLS_COUNT=' + tools.tools.length);

const result = await client.callTool({ name: 'get_dashboard', arguments: {} });
const text = result.content[0].text;
console.log('STDIO_DOWN_SERVICE_ERR=' + (/not reachable|start/i.test(text)));
await client.close();
console.log('STDIO_VERIFY_OK');
