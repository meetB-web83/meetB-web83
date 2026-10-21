// Host-side: connects to the published MCP endpoint (Streamable HTTP) and
// exercises the full project-folder flow through the core service.
import { Client } from '../backend/tests/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../backend/tests/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const CORE = 'http://127.0.0.1:3000'; // dashboard proxy -> core

// 1. Register a project using the container path (what /browse returns).
const projRes = await fetch(`${CORE}/api/projects`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'McpProject', root_path: '/host-projects/McpProject', idempotency_key: 'verify-mcp-proj-002' }),
});
const project = await projRes.json();
console.log('PROJECT=' + JSON.stringify({ id: project.id, root_path: project.root_path, available: project.available }));

// 2. Connect an MCP client to the published endpoint.
const client = new Client({ name: 'host-verify', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3738/mcp')));
const tools = await client.listTools();
console.log('TOOLS_COUNT=' + tools.tools.length);

// 3. Write through the MCP endpoint -> core -> mounted host folder.
const created = await client.callTool({
  name: 'create_task',
  arguments: { project_id: project.id, agent_id: 'verify_' + project.id, title: 'Task via published MCP', idempotency_key: 'verify-mcp-task-002' },
});
const task = JSON.parse(created.content[0].text);
console.log('TASK_ID=' + task.id + ' STATUS=' + task.status);

// 4. Read back via get_task.
const fetched = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } });
const refetched = JSON.parse(fetched.content[0].text);
console.log('REFETCHED_TITLE=' + refetched.title);

await client.close();
console.log('VERIFY_OK');
