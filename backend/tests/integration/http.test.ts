import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer, projectDbPath, type Database, type Config } from '@workjournal/core';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';

/**
 * Spec §9.8: create_task / list_tasks / record_checkpoint round-trip through the real
 * Fastify app (inject, no network), including string-coerced query params and the
 * idempotency contract at the HTTP boundary (409 on conflicting key reuse).
 */
describe('HTTP layer round-trip', () => {
  let registry: Database;
  let cleanupRegistry: () => void;
  let server: ReturnType<typeof buildServer>;
  let projectRoot: string;
  let extraRoots: string[] = [];

  const config: Config = {
    workjournalHome: '~/.workjournal-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const registerProject = async (name: string, rootPath: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name, root_path: rootPath, idempotency_key: `proj-${name}-001` },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  beforeEach(async () => {
    const reg = createRegistryDb();
    registry = reg.db;
    cleanupRegistry = reg.cleanup;
    projectRoot = tempProjectRoot();
    extraRoots = [];
    server = buildServer(registry, config);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    cleanupRegistry();
    rmSync(projectRoot, { recursive: true, force: true });
    for (const root of extraRoots) rmSync(root, { recursive: true, force: true });
  });

  it('project registration initializes the per-project database', async () => {
    const project = await registerProject('HttpDemo', projectRoot);

    expect(project.available).toBe(true);
    expect(existsSync(projectDbPath(projectRoot))).toBe(true);
  });

  it('lists tasks across all projects when project_id is omitted', async () => {
    const secondRoot = tempProjectRoot();
    extraRoots.push(secondRoot);
    const first = await registerProject('First', projectRoot);
    const second = await registerProject('Second', secondRoot);

      for (const [projectId, title, key] of [
        [first.id, 'First project task', 'task-xproj-a-001'],
        [second.id, 'Second project task', 'task-xproj-b-001'],
      ] as const) {
        const res = await server.inject({
          method: 'POST',
          url: '/api/tasks',
          payload: { project_id: projectId, agent_id: 'agent-a_test', title, idempotency_key: key },
        });
        expect(res.statusCode).toBe(201);
      }

      // No project_id: both projects' tasks, newest first.
      const all = await server.inject({ method: 'GET', url: '/api/tasks?limit=100' });
      expect(all.statusCode).toBe(200);
      expect(all.json().map((t: any) => t.title).sort()).toEqual(
        ['First project task', 'Second project task'],
      );

      // Filters still apply across projects.
      const filtered = await server.inject({ method: 'GET', url: '/api/tasks?status=open&limit=100' });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json()).toHaveLength(2);

      // Scoped listing is unchanged.
      const scoped = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${first.id}` });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json().map((t: any) => t.title)).toEqual(['First project task']);
  });

  it('dashboard returns stats, recents and projects, optionally scoped', async () => {
      const secondRoot = tempProjectRoot();
      extraRoots.push(secondRoot);
      const first = await registerProject('First', projectRoot);
      const second = await registerProject('Second', secondRoot);

      const create = async (projectId: string, title: string, key: string) => {
        const c = await server.inject({
          method: 'POST',
          url: '/api/tasks',
          payload: { project_id: projectId, agent_id: 'agent-a_test', title, idempotency_key: key },
        });
        expect(c.statusCode).toBe(201);
        return c.json();
      };
      const claim = async (task: any, key: string) => {
        const c = await server.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/claim`,
          payload: { task_id: task.id, agent_id: 'agent-a_test', expected_version: task.version, idempotency_key: key },
        });
        expect(c.statusCode).toBe(200);
        return c.json();
      };
      const transition = async (task: any, target: string, key: string, extra: Record<string, unknown> = {}) => {
        const c = await server.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/transition`,
          payload: { task_id: task.id, agent_id: 'agent-a_test', expected_version: task.version, target_status: target, idempotency_key: key, ...extra },
        });
        expect(c.statusCode).toBe(200);
        return c.json();
      };

      // First: one completed, one open. Second: one blocked.
      const done = await claim(await create(first.id, 'Done task', 'task-dash-a-001'), 'task-dash-a-claim');
      await transition(done, 'completed', 'task-dash-a-done');
      await create(first.id, 'Open task', 'task-dash-a-002');
      const stuck = await claim(await create(second.id, 'Stuck task', 'task-dash-b-001'), 'task-dash-b-claim');
      await transition(stuck, 'blocked', 'task-dash-b-block', { reason: 'waiting' });

      // Global scope: stats across both projects, full project list, newest recents.
      const overviewRes = await server.inject({ method: 'GET', url: '/api/dashboard' });
      expect(overviewRes.statusCode).toBe(200);
      const overview = overviewRes.json();
      expect(overview.stats).toEqual({ projects: 2, active_tasks: 2, completed: 1, blocked: 1 });
      expect(overview.projects.map((p: any) => p.name).sort()).toEqual(['First', 'Second']);
      expect(overview.projects.every((p: any) => p.id && p.available)).toBe(true);
      expect(overview.recent_tasks).toHaveLength(3);
      expect(overview.recent_tasks[0].title).toBe('Stuck task');

      // recent_limit is honored.
      const limited = await server.inject({ method: 'GET', url: '/api/dashboard?recent_limit=2' });
      expect(limited.json().recent_tasks).toHaveLength(2);

      // Project scope narrows task stats and recents; the project count stays the
      // registry total (the project itself is the scope).
      const scopedRes = await server.inject({ method: 'GET', url: `/api/dashboard?project_id=${first.id}` });
      expect(scopedRes.statusCode).toBe(200);
      expect(scopedRes.json().stats).toEqual({ projects: 2, active_tasks: 1, completed: 1, blocked: 0 });
      expect(scopedRes.json().recent_tasks.map((t: any) => t.title).sort()).toEqual(['Done task', 'Open task']);
      expect(scopedRes.json().projects).toHaveLength(2);

      // Unknown project and bad limit are rejected.
      const missing = await server.inject({ method: 'GET', url: '/api/dashboard?project_id=nope' });
      expect(missing.statusCode).toBe(404);
      const badLimit = await server.inject({ method: 'GET', url: '/api/dashboard?recent_limit=99' });
      expect(badLimit.statusCode).toBe(400);
  });

  it('create_task, list_tasks (coerced query params) and record_checkpoint round-trip', async () => {
    const project = await registerProject('HttpDemo', projectRoot);

    // create_task
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        project_id: project.id,
        agent_id: 'agent-a_test',
        title: 'HTTP round-trip task',
        priority: 'high',
        idempotency_key: 'task-create-001',
      },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.status).toBe('open');
    expect(task.version).toBe(1);
    expect(task.owner).toBeNull();

    // list_tasks: all query params arrive as strings and must coerce cleanly.
    const listed = await server.inject({
      method: 'GET',
      url: `/api/tasks?project_id=${project.id}&status=open&priority=high&limit=25&offset=0`,
    });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(task.id);

    // Claim, then record_checkpoint against the claimed version.
    const claimed = await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/claim`,
      payload: {
        task_id: task.id,
        agent_id: 'agent-a_test',
        expected_version: 1,
        idempotency_key: 'task-claim-001',
      },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().version).toBe(2);

    const checkpoint = await server.inject({
      method: 'POST',
      url: '/api/checkpoints',
      payload: {
        task_id: task.id,
        agent_id: 'agent-a_test',
        progress_summary: 'Wired the HTTP round-trip',
        next_steps: 'Verify events',
        expected_version: 2,
        idempotency_key: 'checkpoint-001',
      },
    });
    expect(checkpoint.statusCode).toBe(201);
    expect(checkpoint.json().task_version).toBe(2);

    // The event history proves the records really landed, in order.
    const history = await server.inject({ method: 'GET', url: `/api/events?task_id=${task.id}` });
    expect(history.statusCode).toBe(200);
    const types = history.json().map((e: any) => e.event_type);
    expect(types).toEqual(['task_created', 'task_claimed', 'checkpoint_recorded']);
  });

  it('serializes JSON-text columns as parsed values on the wire', async () => {
    // SQLite stores acceptance_criteria/payload/file_references/alternatives as TEXT;
    // the contract promises arrays/objects. Regression for the dashboard crash where
    // task.acceptance_criteria arrived as the string "[]" and .map() threw.
    const project = await registerProject('HttpDemo', projectRoot);
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        project_id: project.id,
        agent_id: 'agent-a_test',
        title: 'Wire shape task',
        acceptance_criteria: ['First criterion', 'Second criterion'],
        idempotency_key: 'task-wire-001',
      },
    });
    const task = created.json();
    expect(Array.isArray(task.acceptance_criteria)).toBe(true);
    expect(task.acceptance_criteria).toEqual(['First criterion', 'Second criterion']);

    const fetched = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(Array.isArray(fetched.json().acceptance_criteria)).toBe(true);

    const listed = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${project.id}` });
    expect(Array.isArray(listed.json()[0].acceptance_criteria)).toBe(true);

    await server.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/claim`,
      payload: { task_id: task.id, agent_id: 'agent-a_test', expected_version: 1, idempotency_key: 'task-wire-claim-001' },
    });
    const checkpoint = await server.inject({
      method: 'POST',
      url: '/api/checkpoints',
      payload: {
        task_id: task.id,
        agent_id: 'agent-a_test',
        progress_summary: 'Wire shape checkpoint',
        file_references: ['src/a.ts', 'src/b.ts'],
        expected_version: 2,
        idempotency_key: 'task-wire-cp-001',
      },
    });
    expect(Array.isArray(checkpoint.json().file_references)).toBe(true);
    expect(checkpoint.json().file_references).toEqual(['src/a.ts', 'src/b.ts']);

    const events = await server.inject({ method: 'GET', url: `/api/events?task_id=${task.id}` });
    expect(typeof events.json()[0].payload).toBe('object');

    const decision = await server.inject({
      method: 'POST',
      url: '/api/decisions',
      payload: {
        task_id: task.id,
        agent_id: 'agent-a_test',
        statement: 'Wire shape decision',
        alternatives: ['Alternative A'],
        expected_version: 2,
        idempotency_key: 'task-wire-dec-001',
      },
    });
    expect(Array.isArray(decision.json().alternatives)).toBe(true);
    expect(decision.json().alternatives).toEqual(['Alternative A']);
  });

  it('accepts boolean query params sent as URL strings (dashboard regression)', async () => {
    // The dashboard hits /api/decisions?...&include_superseded=true — a string, not a
    // boolean. Regression for the VALIDATION_ERROR "received string" bug.
    const project = await registerProject('HttpDemo', projectRoot);
    const created = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        project_id: project.id,
        agent_id: 'agent-a_test',
        title: 'Decisions list task',
        idempotency_key: 'task-dec-list-001',
      },
    });
    const task = created.json();

    const withParam = await server.inject({
      method: 'GET',
      url: `/api/decisions?task_id=${task.id}&include_superseded=true`,
    });
    expect(withParam.statusCode).toBe(200);
    expect(withParam.json()).toEqual([]);

    const withoutParam = await server.inject({
      method: 'GET',
      url: `/api/decisions?task_id=${task.id}`,
    });
    expect(withoutParam.statusCode).toBe(200);

    const falseParam = await server.inject({
      method: 'GET',
      url: `/api/decisions?task_id=${task.id}&include_superseded=false`,
    });
    expect(falseParam.statusCode).toBe(200);

    const badParam = await server.inject({
      method: 'GET',
      url: `/api/decisions?task_id=${task.id}&include_superseded=banana`,
    });
    expect(badParam.statusCode).toBe(400);
    expect(badParam.json().error).toBe('VALIDATION_ERROR');
  });

  it('idempotent replay over HTTP returns the stored response; conflicting reuse is 409', async () => {
    const project = await registerProject('HttpDemo', projectRoot);
    const payload = {
      project_id: project.id,
      agent_id: 'agent-a_test',
      title: 'Idempotent over HTTP',
      idempotency_key: 'task-idem-001',
    };

    const first = await server.inject({ method: 'POST', url: '/api/tasks', payload });
    const replay = await server.inject({ method: 'POST', url: '/api/tasks', payload });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);

    const conflict = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { ...payload, title: 'Same key, different title' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const listed = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${project.id}` });
    expect(listed.json()).toHaveLength(1);
  });

  it('rejects writes without an idempotency key', async () => {
    const project = await registerProject('HttpDemo', projectRoot);

    const res = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: project.id, agent_id: 'agent-a_test', title: 'No key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it('returns an actionable error for an unavailable project folder', async () => {
    // Registry row whose folder was never created (or was deleted/moved) — the same
    // "unavailable" state the dashboard shows, without fighting Windows file locks.
    const now = new Date().toISOString();
    registry.raw
      .prepare(
        'INSERT INTO registry_projects (id, name, description, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('proj-ghost', 'Ghost', null, join(projectRoot, 'deleted'), now, now);

    const res = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        project_id: 'proj-ghost',
        agent_id: 'agent-a_test',
        title: 'Orphaned project',
        idempotency_key: 'task-orphan-001',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
    expect(res.json().message).toMatch(/unavailable/i);
  });

  it('browses directories with full paths for the dashboard folder picker', async () => {
    // Fixture: two subdirectories (one already a WorkJournal project) + one file.
    mkdirSync(join(projectRoot, 'alpha'));
    mkdirSync(join(projectRoot, 'beta'));
    writeFileSync(join(projectRoot, 'notes.txt'), 'not a folder');
    mkdirSync(join(projectRoot, 'beta', '.workjournal'));

    // Roots listing is reachable without a path.
    const roots = await server.inject({ method: 'GET', url: '/api/projects/browse' });
    expect(roots.statusCode).toBe(200);
    expect(roots.json().current_path).toBeNull();
    expect(Array.isArray(roots.json().entries)).toBe(true);

    // Directory listing returns full paths, only folders, sorted, with markers.
    const listed = await server.inject({ method: 'GET', url: `/api/projects/browse?path=${encodeURIComponent(projectRoot)}` });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.current_path).toBeTruthy();
    expect(body.parent_path).toBeTruthy();
    expect(body.entries.map((e: any) => e.name)).toEqual(['alpha', 'beta']);
    expect(body.entries.every((e: any) => e.path.includes(e.name))).toBe(true);
    expect(body.entries.find((e: any) => e.name === 'beta')?.has_workjournal).toBe(true);
    expect(body.entries.find((e: any) => e.name === 'alpha')?.has_workjournal).toBe(false);

    // Search narrows case-insensitively.
    const searched = await server.inject({
      method: 'GET',
      url: `/api/projects/browse?path=${encodeURIComponent(projectRoot)}&search=ALP`,
    });
    expect(searched.json().entries.map((e: any) => e.name)).toEqual(['alpha']);

    // Missing folders, files, and files-as-paths are actionable 400s, not crashes.
    const missing = await server.inject({ method: 'GET', url: `/api/projects/browse?path=${encodeURIComponent(join(projectRoot, 'nope'))}` });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('VALIDATION_ERROR');
    const file = await server.inject({ method: 'GET', url: `/api/projects/browse?path=${encodeURIComponent(join(projectRoot, 'notes.txt'))}` });
    expect(file.statusCode).toBe(400);
  });
});
