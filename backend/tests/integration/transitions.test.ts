import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService } from '@workjournal/core';
import { TaskStatus } from '@workjournal/shared';

describe('Task transitions', () => {
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

  it('allows open -> in_progress', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    const claimed = await tasks.claimTask(task.id, 'agent-1', 1);
    expect(claimed.status).toBe(TaskStatus.InProgress);
  });

  it('allows in_progress -> blocked', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await tasks.claimTask(task.id, 'agent-1', 1);
    const blocked = await tasks.transitionTask(task.id, 'agent-1', 2, TaskStatus.Blocked, 'Waiting on dependency');
    expect(blocked.status).toBe(TaskStatus.Blocked);
  });

  it('rejects open -> completed', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await expect(tasks.transitionTask(task.id, 'agent-1', 1, TaskStatus.Completed))
      .rejects.toThrow();
  });

  it('rejects completed -> in_progress', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Test task' });
    await tasks.claimTask(task.id, 'agent-1', 1);
    await tasks.transitionTask(task.id, 'agent-1', 2, TaskStatus.Completed);
    await expect(tasks.transitionTask(task.id, 'agent-1', 3, TaskStatus.InProgress))
      .rejects.toThrow();
  });
});
