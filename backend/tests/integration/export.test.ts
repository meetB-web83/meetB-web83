import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService, CheckpointService, JsonExporter, MarkdownExporter } from '@workjournal/core';

describe('Export', () => {
  let db: any;
  let tasks: TaskService;
  let checkpoints: CheckpointService;
  let jsonExport: JsonExporter;
  let markdownExport: MarkdownExporter;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    tasks = new TaskService(db);
    checkpoints = new CheckpointService(db);
    jsonExport = new JsonExporter(db);
    markdownExport = new MarkdownExporter(db);

    db.raw.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'Test', '/tmp/test', '2024-01-01', '2024-01-01')`).run();
  });

  afterEach(() => cleanup());

  it('produces valid JSON handoff', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task', objective: 'Test objective' });
    await tasks.claimTask(task.id, 'agent-1', 1);
    await checkpoints.createCheckpoint({
      taskId: task.id,
      agentId: 'agent-1',
      progressSummary: 'Done with phase 1',
      expectedVersion: 2,
    });

    const handoff = await jsonExport.exportTask(task.id);
    expect(handoff.format_version).toBe(1);
    expect(handoff.task.title).toBe('Test task');
    expect(handoff.checkpoint).not.toBeNull();
  });

  it('produces valid Markdown handoff', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await tasks.claimTask(task.id, 'agent-1', 1);
    await checkpoints.createCheckpoint({
      taskId: task.id,
      agentId: 'agent-1',
      progressSummary: 'Done with phase 1',
      expectedVersion: 2,
    });

    const markdown = await markdownExport.exportTask(task.id);
    expect(markdown).toContain('# Handoff: Test task');
    expect(markdown).toContain('Done with phase 1');
  });

  it('filters secrets from exports', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test with secret: sk-abc123def456ghi789jkl' });
    const markdown = await markdownExport.exportTask(task.id);
    expect(markdown).not.toContain('sk-abc123def456ghi789jkl');
    expect(markdown).toContain('[REDACTED]');
  });
});
