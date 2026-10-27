import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { buildServer, projectDbPath, type Database, type Config } from '@workjournal/core';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';

/**
 * WS-2.4 + WS-2.5: POST /api/ingest/events through the real Fastify app
 * (inject) — bounded batch, ledger-only 400, per-envelope
 * accepted/duplicate/rejected, event_id idempotency, session-binding
 * task_id backfill, and project-level (task-less) events.
 */
describe('Ingestion API — POST /api/ingest/events', () => {
  let registry: Database;
  let cleanupRegistry: () => void;
  let server: ReturnType<typeof buildServer>;
  let projectRoot: string;
  let projectId: string;

  const config: Config = {
    workjournalHome: '~/.workjournal-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const AGENT = 'mimo_testproj';

  const envelope = (over: Record<string, unknown> = {}) => ({
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    type: 'agent_session_started',
    source: `agent:${AGENT}`,
    actor: AGENT,
    payload: { agent_id: AGENT, session_id: 'sess-1' },
    ...over,
  });

  const post = (events: unknown[], query = `project_id=${projectId}`) =>
    server.inject({
      method: 'POST',
      url: `/api/ingest/events?${query}`,
      payload: { events },
    });

  const createTask = async (title: string, key: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: projectId, agent_id: AGENT, title, idempotency_key: key },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  beforeEach(async () => {
    const reg = createRegistryDb();
    registry = reg.db;
    cleanupRegistry = reg.cleanup;
    projectRoot = tempProjectRoot();
    server = buildServer(registry, config);
    await server.ready();

    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'IngestProj', root_path: projectRoot, idempotency_key: 'ingest-proj-001' },
    });
    expect(res.statusCode).toBe(201);
    projectId = res.json().id;
  });

  afterEach(async () => {
    await server.close();
    cleanupRegistry();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('accepts a valid batch and returns the canonical envelope in listing', async () => {
    const at = '2026-10-27T05:00:00.000Z';
    const res = await post([
      envelope({ occurred_at: at }),
      envelope({
        type: 'progress_milestone',
        payload: { agent_id: AGENT, session_id: 'sess-1', summary: 'M1 done' },
      }),
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toBe(0);
    expect(body.results[0]).toMatchObject({ status: 'accepted', task_id: null, sequence: 1 });
    expect(body.results[1]).toMatchObject({ status: 'accepted', sequence: 2 });

    const list = await server.inject({ method: 'GET', url: `/api/events?project_id=${projectId}` });
    expect(list.statusCode).toBe(200);
    const events = list.json();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event_type: 'agent_session_started',
      category: 'agent',
      source: `agent:${AGENT}`,
      task_id: null,
      occurred_at: at,
    });
    expect(events[0].event_id).toBe(body.results[0].event_id);
  });

  it('rejects batches over 50 envelopes', async () => {
    const batch = Array.from({ length: 51 }, () => envelope());
    const res = await post(batch);
    expect(res.statusCode).toBe(400);
  });

  it('rejects the whole request with 400 when a task-lifecycle type sneaks in (D-023)', async () => {
    const res = await post([
      envelope(),
      envelope({ type: 'task_transitioned', payload: { from: 'in_progress', to: 'completed' } }),
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/ledger-only/i);
  });

  it('reports per-envelope rejection without dropping the valid ones', async () => {
    const res = await post([
      envelope(),
      envelope({
        type: 'progress_milestone',
        payload: { agent_id: AGENT, status: 'completed' }, // strict violation
      }),
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.results[1].status).toBe('rejected');
    expect(body.results[1].reason).toBeTruthy();
  });

  it('accepts agent_tool_call rows and rejects an invalid payload (D-027)', async () => {
    const res = await post([
      envelope({
        type: 'agent_tool_call',
        payload: {
          agent_id: AGENT,
          session_id: 'sess-1',
          tool: 'write_to_file',
          status: 'succeeded',
          duration_ms: 12,
          target: 'src/app.ts',
          tool_call_id: 'call-1',
        },
      }),
      envelope({
        type: 'agent_tool_call',
        payload: {
          agent_id: AGENT,
          session_id: 'sess-1',
          tool: 'write_to_file',
          status: 'done', // not in the enum
          duration_ms: 1,
        },
      }),
      envelope({
        type: 'agent_session_ended',
        payload: {
          agent_id: AGENT,
          session_id: 'sess-1',
          reason: 'completed',
          tool_call_count: 1,
          failed_tool_call_count: 0,
          duration_ms: 900,
          iterations: 2,
          files_touched: ['src/app.ts'],
          input_tokens: 10,
          output_tokens: 5,
        },
      }),
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(1);

    const list = await server.inject({
      method: 'GET',
      url: `/api/events?project_id=${projectId}&category=agent`,
    });
    const types = list.json().map((e: any) => e.event_type);
    expect(types).toContain('agent_tool_call');
    expect(types).toContain('agent_session_ended');
  });

  it('is idempotent by event_id across requests (duplicate, not double)', async () => {
    const evt = envelope();
    const first = await post([evt]);
    expect(first.json().accepted).toBe(1);

    const second = await post([evt]);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicates).toBe(1);
    expect(second.json().results[0]).toMatchObject({ status: 'duplicate', sequence: 1 });

    // Same event_id twice inside ONE batch: first accepted, second duplicate.
    const inBatch = await post([envelope({ event_id: 'twin-key' }), envelope({ event_id: 'twin-key' })]);
    expect(inBatch.json().accepted).toBe(1);
    expect(inBatch.json().duplicates).toBe(1);
  });

  it('backfills task_id from the active session binding (WS-2.5)', async () => {
    const task = await createTask('Bound task', 'ingest-task-001');

    // Claim WITH session_id — as the adapter does when OpenCode sends _meta.
    const claim = await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/claim`,
      payload: {
        task_id: task.id,
        agent_id: AGENT,
        expected_version: task.version,
        idempotency_key: 'ingest-claim-001',
        session_id: 'sess-1',
      },
    });
    expect(claim.statusCode).toBe(200);

    // Plugin event WITHOUT task_id for the same session lands on the task.
    const res = await post([
      envelope({
        type: 'progress_milestone',
        payload: { agent_id: AGENT, session_id: 'sess-1', summary: 'correlated' },
      }),
    ]);
    expect(res.json().results[0]).toMatchObject({ status: 'accepted', task_id: task.id });

    const timeline = await server.inject({ method: 'GET', url: `/api/events?task_id=${task.id}` });
    const types = timeline.json().map((e: any) => e.event_type);
    expect(types).toContain('progress_milestone');

    // An event for an UNBOUND session stays project-level.
    const unbound = await post([
      envelope({
        payload: { agent_id: AGENT, session_id: 'sess-unknown' },
      }),
    ]);
    expect(unbound.json().results[0].task_id).toBeNull();
  });

  it('explicit task_id wins over the binding; releasing the task ends correlation', async () => {
    const t1 = await createTask('Task one', 'ingest-task-002');
    const t2 = await createTask('Task two', 'ingest-task-003');

    await server.inject({
      method: 'POST',
      url: `/api/tasks/${t1.id}/claim`,
      payload: { task_id: t1.id, agent_id: AGENT, expected_version: t1.version, idempotency_key: 'ingest-claim-002', session_id: 'sess-2' },
    });

    // Explicit scope beats the binding.
    const explicit = await post([
      envelope({ task_id: t2.id, payload: { agent_id: AGENT, session_id: 'sess-2', summary: 'x' }, type: 'progress_milestone' }),
    ]);
    expect(explicit.json().results[0].task_id).toBe(t2.id);

    // Releasing t1 ends its session correlation.
    await server.inject({
      method: 'POST',
      url: `/api/tasks/${t1.id}/release`,
      payload: { task_id: t1.id, agent_id: AGENT, expected_version: 2, idempotency_key: 'ingest-release-001' },
    });
    const after = await post([
      envelope({ payload: { agent_id: AGENT, session_id: 'sess-2' } }),
    ]);
    expect(after.json().results[0].task_id).toBeNull();
  });

  it('requires a resolvable project scope', async () => {
    const noProject = await post([envelope()], 'project_id=does-not-exist');
    expect(noProject.statusCode).toBe(404);

    const missing = await server.inject({
      method: 'POST',
      url: '/api/ingest/events',
      payload: { events: [envelope()] },
    });
    expect(missing.statusCode).toBe(400); // query validation
  });

  it('rejects source "core" and malformed sources', async () => {
    const asCore = await post([envelope({ source: 'core' })]);
    expect(asCore.statusCode).toBe(400);
    const bad = await post([envelope({ source: 'has spaces' })]);
    expect(bad.statusCode).toBe(400);
  });
});
