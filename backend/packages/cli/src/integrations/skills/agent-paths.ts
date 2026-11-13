/**
 * Agent skill paths data table (Addendum A).
 *
 * Single source of truth for where each agent looks for global skills.
 * Used by the skills installer to know where to write.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentId =
  | 'opencode'
  | 'cursor'
  | 'cline'
  | 'gemini-cli'
  | 'claude-code'
  | 'antigravity-cli';

export interface AgentSkillPaths {
  /** Agent integration ID. */
  agentId: AgentId;

  /** Global skills directory (XDG/config home). */
  global: (homeDir: string) => string;

  /** Additional directories the agent also reads (for reference). */
  alsoReads?: Array<(homeDir: string) => string>;

  /** File extension for skill files. */
  extension: string;
}

/** Central registry of agent skill paths. */
export const AGENT_SKILL_PATHS: Record<AgentId, AgentSkillPaths> = {
  opencode: {
    agentId: 'opencode',
    global: (homeDir) => join(homeDir, '.config', 'opencode', 'skills'),
    alsoReads: [
      (homeDir) => join(homeDir, '.claude', 'skills'),
      (homeDir) => join(homeDir, '.agents', 'skills'),
    ],
    extension: '.md',
  },
  cursor: {
    agentId: 'cursor',
    global: (homeDir) => join(homeDir, '.cursor', 'skills'),
    extension: '.mdc',
  },
  cline: {
    agentId: 'cline',
    global: (homeDir) => join(homeDir, '.cline', 'skills'),
    extension: '.md',
  },
  'gemini-cli': {
    agentId: 'gemini-cli',
    global: (homeDir) => join(homeDir, '.gemini', 'skills'),
    extension: '.md',
  },
  'claude-code': {
    agentId: 'claude-code',
    global: (homeDir) => join(homeDir, '.claude', 'skills'),
    extension: '.md',
  },
  'antigravity-cli': {
    agentId: 'antigravity-cli',
    global: (homeDir) => {
      // Check candidates in order, return first that exists
      const candidates = [
        join(homeDir, '.gemini', 'config', 'skills'),
        join(homeDir, '.gemini', 'antigravity', 'skills'),
        join(homeDir, '.gemini', 'antigravity-cli', 'skills'),
      ];
      // We can't check existence here (sync), so return primary
      // The installer will check at runtime
      return candidates[0];
    },
    alsoReads: [
      (homeDir) => join(homeDir, '.gemini', 'antigravity', 'skills'),
      (homeDir) => join(homeDir, '.gemini', 'antigravity-cli', 'skills'),
    ],
    extension: '.md',
  },
} as const;

/** Get skill paths for an agent, with runtime existence check for Antigravity. */
export async function resolveGlobalSkillsDir(
  agentId: AgentId,
  homeDir: string,
  fs: { existsSync: (path: string) => boolean }
): Promise<{ path: string; isFallback: boolean }> {
  const config = AGENT_SKILL_PATHS[agentId];
  const primary = config.global(homeDir);

  // For Antigravity, check candidates at runtime
  if (agentId === 'antigravity-cli' && config.alsoReads) {
    const candidates = [primary, ...config.alsoReads.map((fn) => fn(homeDir))];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { path: candidate, isFallback: candidate !== primary };
      }
    }
  }

  return { path: primary, isFallback: false };
}

/** WorkJournal's local skills mirror directory. */
export function workjournalSkillsDir(workjournalHome: string, agentId: AgentId): string {
  return join(workjournalHome, 'skills', agentId);
}