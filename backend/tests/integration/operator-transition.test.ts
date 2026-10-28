import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService } from '@workjournal/core';
import {
  TaskStatus,
  OwnerMismatchError,
  StaleVersionError,
  IdempotencyConflictError,
  OPERATOR,
} from '@workjournal/shared';

describe('Operator status override', () => {
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

  async function createInProgress(owner = 'agent-1') {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Stale task' });
    return await tasks.claimTask(task.id, owner, 1);
  }

  it('operator can complete an in_progress task owned by another agent', async () => {
    const task = await createInProgress('agent-1');
    const completed = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Completed,
      'Stale task cleared by admin',
    );
    expect(completed.status).toBe(TaskStatus.Completed);
    expect(completed.owner).toBe('agent-1');
  });

  it('operator can cancel an in_progress task', async () => {
    const task = await createInProgress('agent-1');
    const cancelled = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Cancelled,
      'No longer needed',
    );
    expect(cancelled.status).toBe(TaskStatus.Cancelled);
  });
  it('operator can reopen an in_progress task to open', async () => {
    const task = await createInProgress('agent-1');
    const reopened = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Open,
      'Returning to backlog',
      'Back in queue',
    );
    expect(reopened.status).toBe(TaskStatus.Open);
  });

  it('operator can block and then unblock a task', async () => {
    const task = await createInProgress('agent-1');
    const blocked = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Blocked,
      'Waiting on external input',
    );
    expect(blocked.status).toBe(TaskStatus.Blocked);

    const unblocked = await tasks.transitionTask(
      task.id,
      OPERATOR,
      blocked.version,
      TaskStatus.Open,
      'Unblocked',
      'Resolved',
    );
    expect(unblocked.status).toBe(TaskStatus.Open);
  });

  it('operator requires a reason for every transition', async () => {
    const task = await createInProgress('agent-1');
    await expect(
      tasks.transitionTask(task.id, OPERATOR, task.version, TaskStatus.Completed),
    ).rejects.toThrow(/Operator transition requires a reason/);
  });

  it('operator bypasses current-owner enforcement', async () => {
    const task = await createInProgress('agent-1');
    await expect(
      tasks.transitionTask(task.id, 'agent-2', task.version, TaskStatus.Completed, 'x'),
    ).rejects.toBeInstanceOf(OwnerMismatchError);
    const completed = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Completed,
      'Admin override',
    );
    expect(completed.status).toBe(TaskStatus.Completed);
  });

  it('operator can override an unclaimed task', async () => {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Unclaimed stale task' });
    const completed = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Completed,
      'Clearing unclaimed stale task',
    );
    expect(completed.status).toBe(TaskStatus.Completed);
  });

  it('operator expected-version conflict returns an error', async () => {
    const task = await createInProgress('agent-1');
    await expect(
      tasks.transitionTask(task.id, OPERATOR, 999, TaskStatus.Completed, 'stale version'),
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it('operator idempotent retry returns stored response without new state', async () => {
    const task = await createInProgress('agent-1');
    const key = 'op-idem-1';
    const input = {
      task_id: task.id,
      agent_id: OPERATOR,
      target_status: TaskStatus.Completed,
      reason: 'Admin override',
      expected_version: task.version,
    };
    const first = await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Completed,
      'Admin override',
      undefined,
      { key, input },
    );
    expect(first.status).toBe(TaskStatus.Completed);
    expect(first.version).toBe(3);

    const second = await tasks.transitionTask(
      task.id,
      OPERATOR,
      3,
      TaskStatus.Completed,
      'Admin override',
      undefined,
      { key, input },
    );
    expect(second.status).toBe(TaskStatus.Completed);
    expect(second.version).toBe(3);
  });

  it('same idempotency key with different input raises conflict', async () => {
    const task = await createInProgress('agent-1');
    const key = 'op-idem-conflict';
    const input = {
      task_id: task.id,
      agent_id: OPERATOR,
      target_status: TaskStatus.Completed,
      reason: 'one',
      expected_version: task.version,
    };
    await tasks.transitionTask(
      task.id,
      OPERATOR,
      task.version,
      TaskStatus.Completed,
      'one',
      undefined,
      { key, input },
    );
    await expect(
      tasks.transitionTask(
        task.id,
        OPERATOR,
        task.version,
        TaskStatus.Completed,
        'two',
        undefined,
        { key, input: { ...input, reason: 'two' } },
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('operator transition records actor operator in append-only event log', async () => {
    const task = await createInProgress('agent-1');
    const eventsBefore = db.raw
      .prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?')
      .get(task.id) as { n: number };

    await tasks.transitionTask(task.id, OPERATOR, task.version, TaskStatus.Completed, 'Admin override');

    const row = db.raw
      .prepare(
        `SELECT actor, event_type, payload FROM events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(task.id) as { actor: string; event_type: string; payload: string };
    expect(row.actor).toBe(OPERATOR);
    expect(row.event_type).toBe('task_transitioned');
    const payload = JSON.parse(row.payload);
    expect(payload.from).toBe(TaskStatus.InProgress);
    expect(payload.to).toBe(TaskStatus.Completed);
    expect(payload.reason).toBe('Admin override');

    const eventsAfter = db.raw
      .prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?')
      .get(task.id) as { n: number };
    expect(eventsAfter.n).toBe(eventsBefore.n + 1);
  });

  it('terminal states cannot be reopened by operator', async () => {
    const task = await createInProgress('agent-1');
    await tasks.transitionTask(task.id, OPERATOR, task.version, TaskStatus.Completed, 'done');
    await expect(
      tasks.transitionTask(task.id, OPERATOR, task.version + 1, TaskStatus.Open, 'reopen'),
    ).rejects.toThrow();
  });

  it('existing agent transition behaviour is unchanged', async () => {
    const task = await createInProgress('agent-1');
    const completed = await tasks.transitionTask(
      task.id,
      'agent-1',
      task.version,
      TaskStatus.Completed,
      'finished',
    );
    expect(completed.status).toBe(TaskStatus.Completed);
    await expect(
      tasks.transitionTask(task.id, 'agent-2', 1, TaskStatus.Open, 'x'),
    ).rejects.toBeInstanceOf(OwnerMismatchError);
  });
});

