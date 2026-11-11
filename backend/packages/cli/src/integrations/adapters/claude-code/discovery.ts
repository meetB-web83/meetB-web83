/**
 * Claude Code discovery and path resolution (plan §10.3, D-021).
 *
 * Claude Code keeps MCP settings in `mcpServers` under:
 *   - `~/.claude.json` (user scope, via `claude mcp add --scope user`)
 *   - `.mcp.json` at the project root (project scope)
 * Hooks live in `.claude/settings.json` under the `hooks` key. Older
 * `~/.claude/settings.json` may exist but MCP env vars only reliably work
 * in `.claude.json` / `.mcp.json`; setup never edits `settings.json` for MCP.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryResult, SetupEnv } from '../../types.js';
import { readConfigFile, getAtPath, isPlainObject } from '../../safe-config.js';
import { resolveCommandPath, isWorkjournalCommand } from '../../command.js';

export interface ClaudeCodePaths {
  scope: 'global' | 'project';
  mcpPath: string;
  mcpCandidates: string[];
  settingsPath: string;
  hooksDir: string;
  hookHandler: string;
}

export function resolveClaudeCodePaths(env: SetupEnv): ClaudeCodePaths {
  const scope = env.scope ?? 'global';
  const home = env.homeDir ?? homedir();

  const mcpPath = scope === 'project' ? join(env.cwd, '.mcp.json') : join(home, '.claude.json');
  const settingsPath = join(home, '.claude', 'settings.json');
  const hooksDir = join(home, '.claude', 'hooks');
  const hookHandler = join(hooksDir, 'workjournal-ingest.js');

  return {
    scope,
    mcpPath,
    mcpCandidates: [mcpPath],
    settingsPath,
    hooksDir,
    hookHandler,
  };
}

/** True when the entry launches the WorkJournal MCP adapter with `mcp` args. */
export function isValidClaudeCodeEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = (entry as any).command;
  if (typeof command !== 'string' || !isWorkjournalCommand(command)) return false;
  const args = Array.isArray((entry as any).args)
    ? (entry as any).args.filter((part: unknown) => typeof part === 'string')
    : [];
  if (args.includes('mcp')) return true;
  return /\bmcp\b/.test(command);
}

export async function discoverClaudeCode(env: SetupEnv): Promise<DiscoveryResult> {
  const paths = resolveClaudeCodePaths(env);
  const binary = resolveCommandPath('claude');
  const checked = [...paths.mcpCandidates, paths.settingsPath, paths.hookHandler];

  if (!binary) {
    return {
      id: 'claude-code',
      state: 'not_installed',
      evidence: ['claude executable not found on PATH'],
      paths: checked,
    };
  }

  const loaded = await readConfigFile(paths.mcpPath);
  if (loaded.error) {
    return {
      id: 'claude-code',
      state: 'configuration_error',
      evidence: [`MCP settings at ${loaded.path} are not valid JSON: ${loaded.error.message}`],
      paths: checked,
      parseError: { file: loaded.path, message: loaded.error.message },
    };
  }

  if (!loaded.exists) {
    return {
      id: 'claude-code',
      state: 'installed_not_configured',
      evidence: [`claude found at ${binary}`, `no MCP settings at ${paths.mcpPath}`],
      paths: checked,
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  const hookHandlerPresent = existsSync(paths.hookHandler);
  const evidence = [
    `claude found at ${binary}`,
    `MCP settings: ${loaded.path}`,
    entry === undefined ? 'mcpServers.workjournal missing' : 'mcpServers.workjournal present',
    hookHandlerPresent ? `hook handler: ${paths.hookHandler}` : `hook handler missing: ${paths.hookHandler}`,
  ];

  if (entry !== undefined && !isValidClaudeCodeEntry(entry)) {
    evidence.push('mcpServers.workjournal does not launch the MCP adapter correctly; re-run setup');
    return { id: 'claude-code', state: 'installed_not_configured', evidence, paths: checked };
  }

  if (entry !== undefined) {
    return { id: 'claude-code', state: 'configured', evidence, paths: checked };
  }
  return { id: 'claude-code', state: 'installed_not_configured', evidence, paths: checked };
}
