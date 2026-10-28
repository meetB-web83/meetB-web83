import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer, type Database, type Config } from '@workjournal/core';
import { createRegistryDb, tempProjectRoot } from '../helpers/registry-factory.js';

describe('WS-7 prompts', () => {
  let registry: Database;
  let cleanupRegistry: () => void;
  let server: ReturnType<typeof buildServer>;
  let projectRoot: string;
  const config: Config = { workjournalHome: '~/.workjournal-test', host: '127.0.0.1', port: 0, logLevel: 'silent', nodeEnv: 'test' };

  beforeEach(async () => {
    const reg = createRegistryDb();
    registry = reg.db;
    cleanupRegistry = reg.cleanup;
    projectRoot = tempProjectRoot();
    server = buildServer(registry, config);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    cleanupRegistry();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const regProject = async () => {
    const res = await server.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P', root_path: projectRoot, idempotency_key: 'proj-001' } });
    return res.json();
  };

  it('seeds 4 built-ins on fresh registry', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/prompts' });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((p: any) => p.name);
    expect(names).toContain('resume_task');
    expect(names).toContain('create_checkpoint');
    expect(names).toContain('record_decision');
    expect(names).toContain('review_handoff');
  });

  it('creates and reads a prompt', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'my_prompt', template: 'Hello {{name}}', idempotency_key: 'k1' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const get = await server.inject({ method: 'GET', url: `/api/prompts/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().name).toBe('my_prompt');
  });

  it('blocks deleting built-in', async () => {
    const list = await server.inject({ method: 'GET', url: '/api/prompts' });
    const builtin = list.json().find((p: any) => p.is_builtin);
    const res = await server.inject({ method: 'DELETE', url: `/api/prompts/${builtin.id}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BUILTIN_PROMPT_PROTECTED');
  });

  it('shadowing: project prompt overrides global', async () => {
    const project = await regProject();
    // create global custom prompt
    await server.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'greet', template: 'global hello', idempotency_key: 'g1' } });
    // create project-scoped prompt same name
    await server.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'greet', template: 'project hello', project_id: project.id, idempotency_key: 'p1' } });
    const resolved = await server.inject({ method: 'GET', url: `/api/prompts?resolved=true&project_id=${project.id}` });
    expect(resolved.statusCode).toBe(200);
    const greet = resolved.json().find((p: any) => p.name === 'greet');
    expect(greet.template).toBe('project hello');
  });

  it('preview renders template', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'tmpl', template: 'Hi {{x}}', idempotency_key: 't1' } });
    const id = res.json().id;
    const prev = await server.inject({ method: 'POST', url: `/api/prompts/${id}/preview`, payload: { args: { x: 'world' } } });
    expect(prev.statusCode).toBe(200);
    expect(prev.json().rendered).toBe('Hi world');
  });

  it('per-scope name uniqueness enforced', async () => {
    const first = await server.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'dup', template: 'a', idempotency_key: 'd1' } });
    expect(first.statusCode).toBe(201);
    const second = await server.inject({ method: 'POST', url: '/api/prompts', payload: { name: 'dup', template: 'b', idempotency_key: 'd2' } });
    expect(second.statusCode).not.toBe(201);
  });
});