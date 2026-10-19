// Runs inside the mcp container: verifies tools/list and a full write flow
// through the MCP endpoint against the core service over the Compose network.
(async () => {
  const { Client } = await import('/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StreamableHTTPClientTransport } = await import('/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');

  // 1. Register a demo project via the core API (as the dashboard would).
  //    Project roots are paths INSIDE the core container; /data is the volume.
  const projRes = await fetch('http://core:3737/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'DockerDemo', root_path: '/data/projects/docker-demo', idempotency_key: 'verify-proj-001' }),
  });
  const project = await projRes.json();
  if (projRes.status !== 201 && projRes.status !== 200) throw new Error('project register failed: ' + projRes.status + ' ' + JSON.stringify(project));

  // 2. Connect an MCP client to the HTTP endpoint.
  const client = new Client({ name: 'compose-verify', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3738/mcp')));
  const tools = await client.listTools();
  console.log('TOOLS_COUNT=' + tools.tools.length);

  // 3. Write through the MCP endpoint (core owns all business rules).
  const created = await client.callTool({
    name: 'create_task',
    arguments: {
      project_id: project.id,
      agent_id: 'verify_' + project.id,
      title: 'Persisted through Docker volume',
      idempotency_key: 'verify-task-001',
    },
  });
  const task = JSON.parse(created.content[0].text);
  console.log('TASK_ID=' + task.id);
  console.log('TASK_STATUS=' + task.status);

  // 4. Read back via get_dashboard.
  const dash = await client.callTool({ name: 'get_dashboard', arguments: {} });
  const stats = JSON.parse(dash.content[0].text).stats;
  console.log('STATS=' + JSON.stringify(stats));
  await client.close();
  console.log('VERIFY_OK');
})().catch((e) => { console.error('VERIFY_FAIL: ' + e.message); process.exit(1); });
