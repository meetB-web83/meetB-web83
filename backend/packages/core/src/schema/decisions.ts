import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  statement: text('statement').notNull(),
  rationale: text('rationale'),
  alternatives: text('alternatives').notNull().default('[]'),
  supportingEventIds: text('supporting_event_ids').notNull().default('[]'),
  status: text('status').notNull().default('active'),
  supersededBy: text('superseded_by'),
  createdAt: text('created_at').notNull(),
});
