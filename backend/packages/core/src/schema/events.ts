import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  taskId: text('task_id').references(() => tasks.id),
  sequence: integer('sequence').notNull(),
  actor: text('actor').notNull(),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull().default('{}'),
  category: text('category').notNull().default('task'),
  source: text('source').notNull().default('core'),
  createdAt: text('created_at').notNull(),
});
