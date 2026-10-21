// Runs inside the mcp container: verifies MCP tools over the Compose network
// and that the core resolves the mounted host projects directory.
(async () => {
  const { Client } = await import('/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StreamableHTTPClientTransport } = await import('/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');

  // Register a project through the core API using the container path.
  const projRes = await fetch('http://core:3737/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'McpProject', root_path: '/host-projects/McpProject', idempotency_key: 'verify-mcp-proj-001' }),
  });
  const project = await projRes.json();
  console.log('PROJECT=' + JSON.stringify({ id: project.id, root_path: project.root_path, available: project.available }));

  const client = new Client({ name: 'compose-verify', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3738/mcp')));
  const tools = await client.listTools();
  console.log('TOOLS_COUNT=' + tools.tools.length);

  const created = await client.callTool({
    name: 'create_task',
    arguments: {
      project_id: project.id,
      agent_id: 'verify_' + project.id,
      title: 'Task via MCP over Compose network',
      idempotency_key: 'verify-mcp-task-001',
    },
  });
  const task = JSON.parse(created.content[0].text);
  console.log('TASK_ID=' + task.id + ' STATUS=' + task.status);

  const dash = await client.callTool({ name: 'get_dashboard', arguments: {} });
  console.log('DASH=' + dash.content[0].text.slice(0, 90));
  await client.close();
  console.log('VERIFY_OK');
})().catch((e) => { console.error('VERIFY_FAIL: ' + e.message); process.exit(1); });
