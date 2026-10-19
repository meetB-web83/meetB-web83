import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const idempotencyRecords = sqliteTable('idempotency_records', {
  key: text('key').primaryKey(),
  operation: text('operation').notNull(),
  actor: text('actor').notNull(),
  inputHash: text('input_hash').notNull(),
  response: text('response').notNull(),
  createdAt: text('created_at').notNull(),
});
