import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const registryProjects = sqliteTable('registry_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const registryIdempotency = sqliteTable('registry_idempotency', {
  key: text('key').primaryKey(),
  operation: text('operation').notNull(),
  actor: text('actor').notNull(),
  inputHash: text('input_hash').notNull(),
  response: text('response').notNull(),
  createdAt: text('created_at').notNull(),
});

export const prompts = sqliteTable('prompts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category').notNull().default('custom'),
  template: text('template').notNull(),
  arguments: text('arguments').notNull().default('[]'),
  projectId: text('project_id'),
  isBuiltin: integer('is_builtin').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
