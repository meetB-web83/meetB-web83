import { resolve } from 'node:path';

/**
 * The WorkJournal home directory with a leading `~` expanded
 * (default `~/.workjournal`), resolved to an absolute path.
 *
 * Every command that touches files under the home (PID file, exports,
 * heartbeats) must resolve it the same way — resolving the raw `~/…` string
 * would silently produce `<cwd>/~/.workjournal` instead of the user's home.
 */
export function workjournalHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WORKJOURNAL_HOME || '~/.workjournal';
  return resolve(raw.replace(/^~/, env.HOME || env.USERPROFILE || '.'));
}
