import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService } from '@workjournal/core';

describe('Concurrency and idempotency', () => {
  let db: any;
  let tasks: TaskService;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    tasks = new TaskService(db);

    db.raw.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'Test', '/tmp/test', '2024-01-01', '2024-01-01')`).run();
  });

  afterEach(() => cleanup());

  it('updates a task without version checks', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    const updated = await tasks.updateTask(task.id, 'agent-1', { title: 'New title' });
    expect(updated.title).toBe('New title');
  });

  it('rejects unauthorized ownership changes', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await tasks.claimTask(task.id, 'agent-1');
    await expect(tasks.releaseTask(task.id, 'agent-2'))
      .rejects.toThrow();
  });
});
