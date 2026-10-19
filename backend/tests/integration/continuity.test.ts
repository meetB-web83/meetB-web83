import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { TaskService, CheckpointService, DecisionService, ResumeBuilder } from '@workjournal/core';

describe('Continuity — Agent A to Agent B handoff', () => {
  let db: any;
  let tasks: TaskService;
  let checkpoints: CheckpointService;
  let decisions: DecisionService;
  let resume: ResumeBuilder;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    tasks = new TaskService(db);
    checkpoints = new CheckpointService(db);
    decisions = new DecisionService(db);
    resume = new ResumeBuilder(db);

    db.raw.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'Test', '/tmp/test', '2024-01-01', '2024-01-01')`).run();
  });

  afterEach(() => cleanup());

  it('Agent B can reconstruct context from Agent A records', async () => {
    // Agent A creates and works on task
    const task = await tasks.createTask({ projectId: 'p1', title: 'Implement feature X', objective: 'Build the thing' });
    await tasks.claimTask(task.id, 'agent-a_p1', 1);

    await checkpoints.createCheckpoint({
      taskId: task.id,
      agentId: 'agent-a_p1',
      progressSummary: 'Completed core module',
      completedWork: 'Built the parser',
      nextSteps: 'Write tests',
      expectedVersion: 2,
    });

    await decisions.createDecision({
      taskId: task.id,
      agentId: 'agent-a_p1',
      statement: 'Use Fastify over Express',
      rationale: 'Better TypeScript support',
      expectedVersion: 2,
    });

    await tasks.transitionTask(task.id, 'agent-a_p1', 2, 'interrupted', 'Session ended');

    // Agent B resumes
    const context = await resume.build(task.id);

    expect(context).toContain('Implement feature X');
    expect(context).toContain('Completed core module');
    expect(context).toContain('Use Fastify over Express');
    expect(context).toContain('Write tests');
  });
});
