import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { projects } from './projects.js';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  objective: text('objective'),
  acceptanceCriteria: text('acceptance_criteria').notNull().default('[]'),
  priority: text('priority').notNull().default('medium'),
  status: text('status').notNull().default('open'),
  owner: text('owner'),
  version: integer('version').notNull().default(1),
  latestCheckpointId: text('latest_checkpoint_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
