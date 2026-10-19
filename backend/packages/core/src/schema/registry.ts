import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
