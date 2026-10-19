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

  it('rejects stale version updates', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await expect(tasks.updateTask(task.id, 'agent-1', 999, { title: 'New title' }))
      .rejects.toThrow('Expected version 999, found 1');
  });

  it('rejects unauthorized ownership changes', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await tasks.claimTask(task.id, 'agent-1', 1);
    await expect(tasks.releaseTask(task.id, 'agent-2', 2))
      .rejects.toThrow();
  });
});
