import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  taskVersion: integer('task_version').notNull(),
  progressSummary: text('progress_summary').notNull(),
  completedWork: text('completed_work'),
  currentFindings: text('current_findings'),
  unresolvedIssues: text('unresolved_issues'),
  nextSteps: text('next_steps'),
  fileReferences: text('file_references').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
});
