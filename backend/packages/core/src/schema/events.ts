import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

/**
 * Canonical event ledger (plan §3 / spec M3, migration 002). `task_id` is
 * nullable for project-level events; `event_id` is the client-generated
 * ingestion dedup key; `category` is derived by Core from the event type.
 * Physical access goes through EventService.append — this file mirrors the
 * storage shape, it is not a second write path.
 */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id').references(() => tasks.id),
    sequence: integer('sequence').notNull(),
    actor: text('actor').notNull(),
    eventType: text('event_type').notNull(),
    category: text('category').notNull().default('task'),
    source: text('source').notNull().default('core'),
    payload: text('payload').notNull().default('{}'),
    eventId: text('event_id'),
    occurredAt: text('occurred_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    eventIdUniq: uniqueIndex('idx_events_event_id').on(table.eventId),
  }),
);
