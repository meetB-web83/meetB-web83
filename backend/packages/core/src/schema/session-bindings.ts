import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

/**
 * Session ↔ task correlation map (plan §2/D-023, migration 002b). One ACTIVE
 * binding per session (released_at NULL, partial unique index); ingestion
 * backfills task_id from it, claiming binds it, releasing a task ends it.
 */
export const sessionTaskBindings = sqliteTable(
  'session_task_bindings',
  {
    sessionId: text('session_id').notNull(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    agentId: text('agent_id').notNull(),
    createdAt: text('created_at').notNull(),
    releasedAt: integer('released_at'),
  },
  (table) => ({
    activeUniq: uniqueIndex('idx_session_bindings_active').on(table.sessionId),
  }),
);
