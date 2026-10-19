import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer, projectDbPath, type Database, type Config } from '@workjournal/core';
import {
  loadPathContext,
  toContainerPath,
  fromContainerPath,
  isWithinRoot,
  normalizeProjectPath,
  validateProjectsMount,
  CONTAINER_PROJECTS_ROOT,
  type PathContext,
} from '@workjournal/core/paths';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';

/**
 * Docker project-folder access: path resolution, project identity and
 * persistence. Real SQLite in temp dirs (no DB mocks); path mapping is
 * tested both as pure functions and through the real Fastify routes with a
 * PathContext whose container root is a real temp directory.
 */

const HOST_ROOT = 'C:/Users/meet.bhesaniya_moont/Documents/PROJECTS';
const dockerCtx: PathContext = { hostRoot: HOST_ROOT, containerRoot: CONTAINER_PROJECTS_ROOT };

describe('path resolution (pure)', () => {
  it('normalises separators and trailing slashes', () => {
    expect(normalizeProjectPath('C:\\Users\\x\\PROJECTS\\')).toBe('C:/Users/x/PROJECTS');
    expect(normalizeProjectPath('  /a/b/  ')).toBe('/a/b');
    expect(normalizeProjectPath('/host-projects/EventFlow/')).toBe('/host-projects/EventFlow');
  });

  it('loadPathContext is null without PROJECTS_DIRECTORY and maps when set', () => {
    expect(loadPathContext({})).toBeNull();
    expect(loadPathContext({ PROJECTS_DIRECTORY: '   ' })).toBeNull();
    const ctx = loadPathContext({ PROJECTS_DIRECTORY: ' C:/Users/x/PROJECTS\\' });
    expect(ctx).toEqual({ hostRoot: 'C:/Users/x/PROJECTS', containerRoot: '/host-projects' });
  });

  it('passes paths through unchanged with no context (native dev)', () => {
    expect(toContainerPath(null, '/any/native/path')).toBe('/any/native/path');
    expect(fromContainerPath(null, '/any/native/path')).toBe('/any/native/path');
  });

  it('keeps container paths as-is', () => {
    expect(toContainerPath(dockerCtx, '/host-projects/EventFlow')).toBe('/host-projects/EventFlow');
    expect(toContainerPath(dockerCtx, '/host-projects')).toBe('/host-projects');
  });

  it('maps host paths (both separator styles) into the container root', () => {
    expect(toContainerPath(dockerCtx, `${HOST_ROOT}/EventFlow`)).toBe('/host-projects/EventFlow');
    expect(toContainerPath(dockerCtx, 'C:\\Users\\meet.bhesaniya_moont\\Documents\\PROJECTS\\EventFlow')).toBe(
      '/host-projects/EventFlow',
    );
    expect(toContainerPath(dockerCtx, `${HOST_ROOT}/nested/deep`)).toBe('/host-projects/nested/deep');
  });

  it('rejects paths outside the configured root', () => {
    expect(() => toContainerPath(dockerCtx, 'C:/Windows')).toThrow();
    expect(() => toContainerPath(dockerCtx, '/etc/passwd')).toThrow();
    expect(() => toContainerPath(dockerCtx, 'D:/other/EventFlow')).toThrow();
  });

  it('rejects traversal attempts after collapsing ..', () => {
    expect(() => toContainerPath(dockerCtx, '/host-projects/../etc')).toThrow();
    expect(() => toContainerPath(dockerCtx, '/host-projects/EventFlow/../../escape')).toThrow();
    expect(() => toContainerPath(dockerCtx, `${HOST_ROOT}/../escape`)).toThrow();
  });

  it('maps container paths back to host paths for display', () => {
    expect(fromContainerPath(dockerCtx, '/host-projects/EventFlow')).toBe(`${HOST_ROOT}/EventFlow`);
    expect(fromContainerPath(dockerCtx, '/somewhere/else')).toBe('/somewhere/else');
  });

  it('isWithinRoot is segment-safe (no prefix confusion)', () => {
    expect(isWithinRoot('/host-projects', '/host-projects')).toBe(true);
    expect(isWithinRoot('/host-projects', '/host-projects/EventFlow')).toBe(true);
    expect(isWithinRoot('/host-projects', '/host-projects-evil')).toBe(false);
    expect(isWithinRoot('/host-projects', '/etc')).toBe(false);
  });

  it('validateProjectsMount: null when unset, actionable error when mount missing', () => {
    expect(validateProjectsMount({})).toBeNull();
    // No /host-projects mount exists on the test machine → actionable message.
    const err = validateProjectsMount({ PROJECTS_DIRECTORY: 'C:/Users/test/PROJECTS' });
    expect(err).toMatch(/PROJECTS_DIRECTORY is set/);
    expect(err).toMatch(/File sharing/);
  });
});

describe('project identity and persistence (native mode)', () => {
  let registry: Database;
  let cleanupRegistry: () => void;
  let server: ReturnType<typeof buildServer>;
  let rootA: string;
  let rootB: string;
  let extraRoots: string[] = [];

  const config: Config = {
    workjournalHome: '~/.workjournal-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
    pathContext: null,
  };

  const registerProject = async (name: string, rootPath: string, key?: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name, root_path: rootPath, idempotency_key: key ?? crypto.randomUUID() },
    });
    return res;
  };

  beforeEach(async () => {
    const reg = createRegistryDb();
    registry = reg.db;
    cleanupRegistry = reg.cleanup;
    server = buildServer(registry, config);
    await server.ready();
    rootA = tempProjectRoot();
    rootB = tempProjectRoot();
    extraRoots = [rootA, rootB];
  });

  afterEach(async () => {
    await server.close();
    cleanupRegistry();
    for (const root of extraRoots) rmSync(root, { recursive: true, force: true });
  });

  it('keeps two projects with identical folder names under different parents distinct', async () => {
    mkdirSync(join(rootA, 'EventFlow'), { recursive: true });
    mkdirSync(join(rootB, 'EventFlow'), { recursive: true });
    const a = await registerProject('EventFlow', join(rootA, 'EventFlow'));
    const b = await registerProject('EventFlow', join(rootB, 'EventFlow'));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const pa = a.json();
    const pb = b.json();
    expect(pa.id).not.toBe(pb.id);
    expect(pa.root_path).not.toBe(pb.root_path);
    expect(pa.available).toBe(true);
    expect(pb.available).toBe(true);
  });

  it('re-registering the same folder (any path form) returns the same project', async () => {
    mkdirSync(join(rootA, 'Demo'), { recursive: true });
    const first = await registerProject('Demo', join(rootA, 'Demo'));
    const id = first.json().id;

    const again = await registerProject('Demo', join(rootA, 'Demo'), 'different-key');
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(id);

    const trailingSlash = await registerProject('Demo', `${join(rootA, 'Demo')}/`, 'third-key');
    expect(trailingSlash.json().id).toBe(id);

    const list = await server.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toHaveLength(1);
  });

  it('a moved/renamed folder registers as a NEW project; history stays with the old folder', async () => {
    // Project A at rootA/Moved with a task inside.
    mkdirSync(join(rootA, 'Moved'), { recursive: true });
    const a = await registerProject('Moved', join(rootA, 'Moved'));
    const projectA = a.json();
    const taskRes = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: projectA.id, agent_id: `agent-a_${projectA.id}`, title: 'original task', idempotency_key: 'moved-task-001' },
    });
    expect(taskRes.statusCode).toBe(201);

    // Same folder name now under a different parent → new project, no merge.
    mkdirSync(join(rootB, 'Moved'), { recursive: true });
    const b = await registerProject('Moved', join(rootB, 'Moved'));
    const projectB = b.json();
    expect(projectB.id).not.toBe(projectA.id);

    const tasksA = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${projectA.id}` });
    const tasksB = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${projectB.id}` });
    expect(tasksA.json()).toHaveLength(1);
    expect(tasksB.json()).toHaveLength(0);
  });

  it('marks a project unavailable when its folder disappears, without affecting others', async () => {
    mkdirSync(join(rootA, 'Vanishing'), { recursive: true });
    mkdirSync(join(rootB, 'Stable'), { recursive: true });
    const a = await registerProject('Vanishing', join(rootA, 'Vanishing'));
    const idA = a.json().id;
    const b = await registerProject('Stable', join(rootB, 'Stable'));
    expect(b.json().available).toBe(true);

    // Close the server first: on Windows the open SQLite handle inside the
    // folder makes rmSync fail with EBUSY.
    await server.close();
    rmSync(join(rootA, 'Vanishing'), { recursive: true, force: true });

    // Re-open to observe availability state.
    server = buildServer(registry, config);
    await server.ready();

    const list = await server.inject({ method: 'GET', url: '/api/projects' });
    const rows = list.json() as Array<{ id: string; available: boolean }>;
    expect(rows.find((r) => r.id === idA).available).toBe(false);
    expect(rows.find((r) => r.id === b.json().id).available).toBe(true);

    // Operations against the missing project fail clearly; the healthy one works.
    const dead = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${idA}` });
    expect(dead.statusCode).toBe(404);
    expect(dead.json().message).toMatch(/unavailable/);

    const alive = await server.inject({ method: 'GET', url: `/api/tasks?project_id=${b.json().id}` });
    expect(alive.statusCode).toBe(200);
  });

  it('persists per-project artifacts at each registered root (no crossing)', async () => {
    mkdirSync(join(rootA, 'Alpha'), { recursive: true });
    mkdirSync(join(rootB, 'Beta'), { recursive: true });
    const a = (await registerProject('Alpha', join(rootA, 'Alpha'))).json();
    const b = (await registerProject('Beta', join(rootB, 'Beta'))).json();

    for (const [project, key] of [
      [a, 'alpha-task-001'],
      [b, 'beta-task-001'],
    ] as const) {
      const task = await server.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { project_id: project.id, agent_id: `agent-a_${project.id}`, title: `task in ${project.name}`, idempotency_key: key },
      });
      expect(task.statusCode).toBe(201);
      const taskId = task.json().id;
      await server.inject({
        method: 'POST',
        url: '/api/checkpoints',
        payload: { task_id: taskId, agent_id: `agent-a_${project.id}`, progress_summary: 'progress', idempotency_key: `${key}-ckpt` },
      });
    }

    // Each project DB exists at its own registered root, and only there.
    const dbA = projectDbPath(a.root_path);
    const dbB = projectDbPath(b.root_path);
    expect(dbA).not.toBe(dbB);
    expect(existsSync(dbA)).toBe(true);
    expect(existsSync(dbB)).toBe(true);
    expect(dbA).toContain('Alpha');
    expect(dbB).toContain('Beta');

    // History and export resolve per project.
    const histA = await server.inject({ method: 'GET', url: `/api/events?task_id=${(await server.inject({ method: 'GET', url: `/api/tasks?project_id=${a.id}` })).json()[0].id}` });
    expect(histA.statusCode).toBe(200);
    expect(histA.json().length).toBeGreaterThan(0);

    const taskIdA = (await server.inject({ method: 'GET', url: `/api/tasks?project_id=${a.id}` })).json()[0].id;
    const exportRes = await server.inject({ method: 'GET', url: `/api/export/markdown?task_id=${taskIdA}` });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.body).toContain('HANDOFF.md v1');
  });
});

describe('docker-mode registration and browse (pathContext with real container root)', () => {
  let registry: Database;
  let cleanupRegistry: () => void;
  let server: ReturnType<typeof buildServer>;
  let containerRoot: string;
  let extraRoots: string[] = [];

  const makeConfig = (pathContext: PathContext): Config => ({
    workjournalHome: '~/.workjournal-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
    pathContext,
  });

  beforeEach(async () => {
    const reg = createRegistryDb();
    registry = reg.db;
    cleanupRegistry = reg.cleanup;
    containerRoot = tempProjectRoot();
    extraRoots = [containerRoot];
    server = buildServer(registry, makeConfig({ hostRoot: HOST_ROOT, containerRoot }));
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    cleanupRegistry();
    for (const root of extraRoots) rmSync(root, { recursive: true, force: true });
  });

  const hostPath = (rel: string) => `${HOST_ROOT}/${rel}`;

  it('registers a HOST path by mapping it to the container root', async () => {
    mkdirSync(join(containerRoot, 'EventFlow'), { recursive: true });
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'EventFlow', root_path: hostPath('EventFlow'), idempotency_key: 'docker-reg-001' },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json();
    // Stored root is the container path, not the host path.
    const expectedRoot = normalizeProjectPath(join(containerRoot, 'EventFlow'));
    expect(project.root_path).toBe(expectedRoot);
    expect(project.root_path).not.toBe(hostPath('EventFlow'));
    expect(project.root_path.startsWith(normalizeProjectPath(containerRoot))).toBe(true);
    expect(project.available).toBe(true);
    // The project DB was created inside the container root.
    expect(existsSync(projectDbPath(project.root_path))).toBe(true);
  });

  it('treats host and container forms of the same folder as one project', async () => {
    mkdirSync(join(containerRoot, 'OneProject'), { recursive: true });
    const viaHost = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'OneProject', root_path: hostPath('OneProject'), idempotency_key: 'docker-reg-002' },
    });
    expect(viaHost.statusCode).toBe(201);
    const id = viaHost.json().id;

    const viaContainer = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'OneProject', root_path: join(containerRoot, 'OneProject'), idempotency_key: 'docker-reg-003' },
    });
    expect(viaContainer.statusCode).toBe(201);
    expect(viaContainer.json().id).toBe(id);
  });

  it('rejects paths outside the configured root with an actionable error', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Evil', root_path: 'C:/Windows/System32', idempotency_key: 'docker-reg-004' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/outside the configured projects directory/);
  });

  it('browse lists immediate children of the projects root only', async () => {
    mkdirSync(join(containerRoot, 'EventFlow'), { recursive: true });
    mkdirSync(join(containerRoot, 'nested', 'inner'), { recursive: true });

    const res = await server.inject({ method: 'GET', url: '/api/projects/browse' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    // Documented discovery rule: immediate children only — no recursive nesting.
    expect(names).toContain('EventFlow');
    expect(names).toContain('nested');
    expect(names).not.toContain('inner');
    // Display paths are host paths; navigation state uses the same form.
    const eventFlow = body.entries.find((e: { name: string }) => e.name === 'EventFlow');
    expect(eventFlow.path).toBe(hostPath('EventFlow'));
    expect(body.current_path).toBe(HOST_ROOT);
  });

  it('browse accepts a host or container path and returns host paths', async () => {
    mkdirSync(join(containerRoot, 'BrowseMe'), { recursive: true });
    const viaHost = await server.inject({ method: 'GET', url: `/api/projects/browse?path=${encodeURIComponent(hostPath('BrowseMe'))}` });
    expect(viaHost.statusCode).toBe(200);
    expect(viaHost.json().current_path).toBe(hostPath('BrowseMe'));

    const viaContainer = await server.inject({
      method: 'GET',
      url: `/api/projects/browse?path=${encodeURIComponent(join(containerRoot, 'BrowseMe'))}`,
    });
    expect(viaContainer.statusCode).toBe(200);
    expect(viaContainer.json().current_path).toBe(hostPath('BrowseMe'));
  });

  it('browse rejects paths outside the projects root', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/projects/browse?path=C:/Windows' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/outside the configured projects directory/);
  });
});

describe('compose and startup validation', () => {
  it('compose mounts PROJECTS_DIRECTORY at /host-projects in the core service only', () => {
    const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
    expect(compose).toContain('PROJECTS_DIRECTORY:');
    expect(compose).toContain('/host-projects');
    expect(compose).toContain('${PROJECTS_DIRECTORY:?');
    // The mount belongs to core, not to the HTTP-only mcp adapter.
    const mcpSection = compose.slice(compose.indexOf('  mcp:'));
    expect(mcpSection).not.toContain('/host-projects');
    const webSection = mcpSection.slice(mcpSection.indexOf('  web:'));
    expect(webSection).not.toContain('/host-projects');
  });

  it('buildServer fails fast with an actionable error when the mount is missing', async () => {
    const reg = createRegistryDb();
    const config: Config = {
      workjournalHome: reg.dir,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      nodeEnv: 'test',
      pathContext: loadPathContext({ PROJECTS_DIRECTORY: 'C:/Users/test/PROJECTS' }),
    };
    process.env.PROJECTS_DIRECTORY = 'C:/Users/test/PROJECTS';
    try {
      expect(() => buildServer(reg.db, config)).toThrow(/readable\/writable/);
    } finally {
      delete process.env.PROJECTS_DIRECTORY;
      reg.cleanup();
    }
  });
});
