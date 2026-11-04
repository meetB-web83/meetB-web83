#!/usr/bin/env node
/**
 * Cleanup test prompts from registry DB.
 * Removes 'normal_updated' and 'notification_test' prompts that are test leftovers.
 */

import { expandHomeDir } from '../backend/packages/mcp-adapter/src/autostart.js';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const homeDir = expandHomeDir();
const registryPath = resolve(homeDir, 'registry.db');

console.log(`Cleaning up test prompts in ${registryPath}`);

const db = new Database(registryPath);

try {
  // Check existing prompts
  const prompts = db.prepare('SELECT id, name, description FROM prompts').all();
  console.log('Current prompts:');
  for (const p of prompts) {
    console.log(`  ${p.id} | ${p.name} | ${p.description}`);
  }

  // Delete test prompts
  const deleted = db.prepare('DELETE FROM prompts WHERE name IN (?, ?)').run('normal_updated', 'notification_test');
  console.log(`\nDeleted ${deleted.changes} test prompts`);

  // Show remaining
  const remaining = db.prepare('SELECT id, name, description FROM prompts').all();
  console.log('Remaining prompts:');
  for (const p of remaining) {
    console.log(`  ${p.id} | ${p.name} | ${p.description}`);
  }
} finally {
  db.close();
}