import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db-factory.js';
import { EventService } from '@workjournal/core';

/**
 * WS-2.3: the single append() funnel — sequence scoping (per task, per
 * project for task-less events), event_id idempotency, strict payload
 * validation, category/source derivation, and WS-3.1 filtered listing.
 */
describe('EventService.append — canonical funnel', () => {
  let db: ReturnType<typeof createTestDb>;
  let events: EventService;

  beforeEach(() => {
    db = createTestDb();
    db.db.raw
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'P1', '/p1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.db.raw
      .prepare(
        `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'T1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    db.db.raw
      .prepare(
        `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t2', 'p1', 'T2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    events = new EventService(db.db);
  });

  afterEach(() => db.cleanup());

  it('sequences per task, independently of other tasks', () => {
    const a1 = events.append({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'progress_milestone', payload: { agent_id: 'mimo_p1', summary: 'first' },
    });
    const a2 = events.append({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'progress_milestone', payload: { agent_id: 'mimo_p1', summary: 'second' },
    });
    const b1 = events.append({
      projectId: 'p1', taskId: 't2', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'progress_milestone', payload: { agent_id: 'mimo_p1', summary: 'other task' },
    });
    expect([a1.sequence, a2.sequence]).toEqual([1, 2]);
    expect(b1.sequence).toBe(1);
  });

  it('sequences project-level (task-less) events per project, task_id NULL', () => {
    const s1 = events.append({
      projectId: 'p1', taskId: null, actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'agent_session_started', payload: { agent_id: 'mimo_p1', session_id: 's-1' },
    });
    const s2 = events.append({
      projectId: 'p1', taskId: null, actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'agent_session_ended',
      payload: { agent_id: 'mimo_p1', session_id: 's-1', reason: 'completed' },
    });
    expect([s1.sequence, s2.sequence]).toEqual([1, 2]);
    const row = db.db.raw.prepare('SELECT task_id, category, source FROM events WHERE id = ?').get(s1.id) as any;
    expect(row.task_id).toBeNull();
    expect(row.category).toBe('agent');
    expect(row.source).toBe('agent:mimo_p1');
  });

  it('dedups by event_id: duplicate returns the stored event, no new row', () => {
    const first = events.append({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'progress_milestone', payload: { agent_id: 'mimo_p1', summary: 'x' },
      eventId: 'evt-42',
    });
    const again = events.append({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'progress_milestone', payload: { agent_id: 'mimo_p1', summary: 'x' },
      eventId: 'evt-42',
    });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.sequence).toBe(first.sequence);
    const count = db.db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as any;
    expect(count.n).toBe(1);
  });

  it('rejects strict-schema violations (unknown key on an agent payload)', () => {
    expect(() =>
      events.append({
        projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
        eventType: 'progress_milestone',
        // summary missing + status smuggled in → must be rejected (M3 §2)
        payload: { agent_id: 'mimo_p1', status: 'completed' },
      }),
    ).toThrow();
  });

  it('agent events can never carry a status field, even with a valid summary', () => {
    expect(() =>
      events.append({
        projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
        eventType: 'progress_fulfilment',
        payload: { agent_id: 'mimo_p1', summary: 'done', status: 'completed' },
      }),
    ).toThrow(/unrecognized|strict|status/i);
  });

  it('keeps the legacy recordEvent path working (source core, no event_id)', () => {
    const rec = events.recordEvent({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', eventType: 'task_created',
      payload: { title: 'T1', priority: 'medium' },
    });
    expect(rec).toMatchObject({ sequence: 1 });
    const row = db.db.raw.prepare('SELECT * FROM events WHERE id = ?').get(rec.id) as any;
    expect(row.source).toBe('core');
    expect(row.category).toBe('task');
    expect(row.event_id).toBeNull();
    expect(row.occurred_at).toBe(row.created_at);
  });

  it('preserves occurred_at when provided (ingestion)', () => {
    const at = '2026-10-27T01:02:03.000Z';
    const rec = events.append({
      projectId: 'p1', taskId: null, actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'agent_session_started', payload: { agent_id: 'mimo_p1', session_id: 's-9' },
      eventId: 'evt-occurred', occurredAt: at,
    });
    expect(rec.occurred_at).toBe(at);
  });

  it('lists with category and source filters, ordered by sequence', () => {
    events.append({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'progress_milestone', payload: { agent_id: 'mimo_p1', summary: 'm1' },
    });
    events.recordEvent({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', eventType: 'task_claimed', payload: { owner: 'mimo_p1' },
    });
    events.append({
      projectId: 'p1', taskId: 't1', actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'verification_passed', payload: { agent_id: 'mimo_p1', check_type: 'typecheck' },
    });

    const all = events.listEvents({ taskId: 't1' });
    expect(all.map((e: any) => e.event_type)).toEqual(['progress_milestone', 'task_claimed', 'verification_passed']);

    const progress = events.listEvents({ taskId: 't1', category: 'progress' });
    expect(progress).toHaveLength(1);

    const bySource = events.listEvents({ taskId: 't1', source: 'agent:mimo_p1' });
    expect(bySource.map((e: any) => e.event_type)).toEqual(['progress_milestone', 'verification_passed']);
  });

  it('lists project-level history (task-less) separately from task timelines', () => {
    events.append({
      projectId: 'p1', taskId: null, actor: 'mimo_p1', source: 'agent:mimo_p1',
      eventType: 'agent_session_started', payload: { agent_id: 'mimo_p1', session_id: 's-1' },
    });
    events.recordEvent({ projectId: 'p1', taskId: 't1', actor: 'mimo_p1', eventType: 'task_created', payload: { title: 'T1', priority: 'medium' } });

    const projectHistory = events.listEvents({ projectId: 'p1' });
    expect(projectHistory).toHaveLength(1);
    expect(projectHistory[0].task_id).toBeNull();

    const taskTimeline = events.listEvents({ taskId: 't1' });
    expect(taskTimeline).toHaveLength(1);
    expect(taskTimeline[0].task_id).toBe('t1');
  });

  it('recordAgentEvent wrapper derives source from the actor', () => {
    const rec = events.recordAgentEvent({
      projectId: 'p1', taskId: 't1', actor: 'cline_p1',
      eventType: 'agent_interrupted', payload: { agent_id: 'cline_p1', session_id: 's-2' },
    });
    const row = db.db.raw.prepare('SELECT source, category FROM events WHERE id = ?').get(rec.id) as any;
    expect(row.source).toBe('agent:cline_p1');
    expect(row.category).toBe('agent');
  });
});
