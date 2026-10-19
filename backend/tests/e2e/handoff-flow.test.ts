import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService, CheckpointService, DecisionService, ResumeBuilder, EventService } from '@workjournal/core';

describe('E2E — Full handoff flow', () => {
  let db: any;
  let tasks: TaskService;
  let checkpoints: CheckpointService;
  let decisions: DecisionService;
  let events: EventService;
  let resume: ResumeBuilder;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    tasks = new TaskService(db);
    checkpoints = new CheckpointService(db);
    decisions = new DecisionService(db);
    events = new EventService(db);
    resume = new ResumeBuilder(db);

    db.raw.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('proj-1', 'WorkJournal', '/tmp/wj', '2024-01-01', '2024-01-01')`).run();
  });

  afterEach(() => cleanup());

  it('complete Agent A → Agent B flow with all records', async () => {
    // 1. Agent A creates task
    const task = await tasks.createTask({
      projectId: 'proj-1',
      title: 'Implement OAuth flow',
      objective: 'Add OAuth2 authentication',
      acceptanceCriteria: ['User can login with Google', 'Token refresh works'],
      priority: 'high',
    });

    // 2. Agent A claims and works
    await tasks.claimTask(task.id, 'agent-a_proj-1', 1);
    await events.recordEvent({ projectId: 'proj-1', taskId: task.id, actor: 'agent-a_proj-1', eventType: 'work_started', payload: {} });

    // 3. Agent A records progress
    await checkpoints.createCheckpoint({
      taskId: task.id,
      agentId: 'agent-a_proj-1',
      progressSummary: 'Implemented authorization code flow',
      completedWork: 'Set up OAuth client, callback handler',
      currentFindings: 'Google requires exact redirect URI match',
      nextSteps: 'Implement token refresh',
      expectedVersion: 2,
    });

    // 4. Agent A makes a decision
    await decisions.createDecision({
      taskId: task.id,
      agentId: 'agent-a_proj-1',
      statement: 'Use authorization code flow with PKCE',
      rationale: 'Most secure for public clients',
      expectedVersion: 2,
    });

    // 5. Agent A gets interrupted
    await tasks.transitionTask(task.id, 'agent-a_proj-1', 2, 'interrupted', 'Session token expired');

    // 6. Agent B picks up
    const context = await resume.build(task.id);
    expect(context).toContain('Implement OAuth flow');
    expect(context).toContain('Add OAuth2 authentication');
    expect(context).toContain('authorization code flow with PKCE');
    expect(context).toContain('Implement token refresh');

    // 7. Agent B claims and continues
    await tasks.claimTask(task.id, 'agent-b_proj-1', 3);
    const claimed = await tasks.getTask(task.id);
    expect(claimed.owner).toBe('agent-b_proj-1');
    expect(claimed.status).toBe('in_progress');
  });
});
