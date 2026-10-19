import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService } from '@workjournal/core';
import { IdempotencyConflictError } from '@workjournal/shared';

/**
 * Spec §9.4 (second half — concurrency/stale versions live in concurrency.test.ts):
 * an equivalent retry with the same key returns the stored response and creates no
 * second event; conflicting reuse raises IDEMPOTENCY_KEY_CONFLICT; a rejected call
 * leaves no idempotency record behind.
 */
describe('Idempotent replay and conflict', () => {
  let db: any;
  let tasks: TaskService;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    tasks = new TaskService(db);
    db.raw
      .prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'Test', '/tmp/test', '2024-01-01', '2024-01-01')`)
      .run();
  });

  afterEach(() => cleanup());

  const createWithKey = (key: string, title = 'Idempotent task') =>
    tasks.createTask({
      projectId: 'p1',
      title,
      agentId: 'agent-a_p1',
      idempotency: { key, input: { project_id: 'p1', title } },
    });

  it('replays the stored response for an equivalent retry and records no second event', async () => {
    const first = await createWithKey('key-abc-123');
    const replay = await createWithKey('key-abc-123');

    expect(replay.id).toBe(first.id);
    expect(replay.version).toBe(1);

    const taskCount = db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as any;
    expect(taskCount.n).toBe(1);

    const eventCount = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'task_created'`)
      .get(first.id) as any;
    expect(eventCount.n).toBe(1);

    const idemCount = db.raw.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get() as any;
    expect(idemCount.n).toBe(1);
  });

  it('rejects conflicting reuse of a key with a different input', async () => {
    await createWithKey('key-conflict-1', 'Original title');

    const err = await createWithKey('key-conflict-1', 'Different title').catch((e) => e);
    expect(err).toBeInstanceOf(IdempotencyConflictError);
    expect(err.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const taskCount = db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as any;
    expect(taskCount.n).toBe(1);
  });

  it('a rejected operation consumes no idempotency record', async () => {
    const task = await createWithKey('key-clean-1');

    // Transition fails: the task is unclaimed (owner mismatch) — nothing should persist.
    await expect(
      tasks.transitionTask(task.id, 'agent-a_p1', 1, 'completed', undefined, undefined, {
        key: 'key-rejected-1',
        input: { task_id: task.id, target_status: 'completed' },
      }),
    ).rejects.toThrow();

    const record = db.raw.prepare('SELECT * FROM idempotency_records WHERE key = ?').get('key-rejected-1');
    expect(record).toBeUndefined();

    // Retrying the same key after fixing the input must succeed, not 409.
    await tasks.claimTask(task.id, 'agent-a_p1', 1, {
      key: 'key-claim-1',
      input: { task_id: task.id, agent_id: 'agent-a_p1', expected_version: 1 },
    });
    const done = await tasks.transitionTask(task.id, 'agent-a_p1', 2, 'completed', undefined, undefined, {
      key: 'key-rejected-1',
      input: { task_id: task.id, target_status: 'completed' },
    });
    expect(done.status).toBe('completed');
  });

  it('two competing claims produce exactly one owner', async () => {
    const task = await createWithKey('key-race-1');

    await tasks.claimTask(task.id, 'agent-a_p1', 1, {
      key: 'key-claim-a',
      input: { task_id: task.id, agent_id: 'agent-a_p1', expected_version: 1 },
    });

    // Agent B's claim loses cleanly: in_progress is not claimable again, so the
    // transition check rejects it before any state change — no owner flip, one event.
    await expect(
      tasks.claimTask(task.id, 'agent-b_p1', 1, {
        key: 'key-claim-b',
        input: { task_id: task.id, agent_id: 'agent-b_p1', expected_version: 1 },
      }),
    ).rejects.toThrow(/cannot claim a task in status/i);

    const after = tasks.getTask(task.id);
    expect(after.owner).toBe('agent-a_p1');
    expect(after.version).toBe(2);

    const claimEvents = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'task_claimed'`)
      .get(task.id) as any;
    expect(claimEvents.n).toBe(1);
  });
});
