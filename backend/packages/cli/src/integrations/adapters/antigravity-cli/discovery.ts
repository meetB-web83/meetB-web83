/**
 * Antigravity CLI discovery and path resolution (plan §10.3, D-021).
 *
 * Antigravity CLI (the successor to Gemini CLI) invokes `agy` and keeps MCP
 * servers in a standalone `mcp_config.json` profile instead of inline in
 * `settings.json`:
 *   - Global MCP: `~/.gemini/config/mcp_config.json`
 *   Project MCP: `.agents/mcp_config.json`
 * Settings live at `~/.gemini/antigravity-cli/settings.json` and plugins at
 * `~/.gemini/config/plugins/` (global) or `.agents/plugins/` (project).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryResult, SetupEnv } from '../../types.js';
import { readConfigFile, getAtPath, isPlainObject } from '../../safe-config.js';
import { resolveCommandPath, isWorkjournalCommand } from '../../command.js';

export interface AntigravityCliPaths {
  scope: 'global' | 'project';
  mcpConfigPath: string;
  mcpConfigCandidates: string[];
  settingsPath: string;
  pluginsDir: string;
  pluginEntry: string;
}

export function resolveAntigravityCliPaths(env: SetupEnv): AntigravityCliPaths {
  const scope = env.scope ?? 'global';
  const home = env.homeDir ?? homedir();

  const antigravityDir = join(home, '.gemini', 'antigravity-cli');
  const settingsPath = join(antigravityDir, 'settings.json');

  const configDir = join(home, '.gemini', 'config');
  const mcpConfigPath =
    scope === 'project' ? join(env.cwd, '.agents', 'mcp_config.json') : join(configDir, 'mcp_config.json');

  const pluginsDir = scope === 'project' ? join(env.cwd, '.agents', 'plugins') : join(configDir, 'plugins');
  const pluginEntry = join(pluginsDir, 'workjournal');

  return {
    scope,
    mcpConfigPath,
    mcpConfigCandidates: [mcpConfigPath],
    settingsPath,
    pluginsDir,
    pluginEntry,
  };
}

/** True when the entry launches the WorkJournal MCP adapter with `mcp` args. */
export function isValidAntigravityCliEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = (entry as any).command;
  if (typeof command !== 'string' || !isWorkjournalCommand(command)) return false;
  const args = Array.isArray((entry as any).args)
    ? (entry as any).args.filter((part: unknown) => typeof part === 'string')
    : [];
  if (args.includes('mcp')) return true;
  return /\bmcp\b/.test(command);
}

export async function discoverAntigravityCli(env: SetupEnv): Promise<DiscoveryResult> {
  const paths = resolveAntigravityCliPaths(env);
  const binary = resolveCommandPath('agy');
  const checked = [...paths.mcpConfigCandidates, paths.pluginEntry];

  if (!binary) {
    return {
      id: 'antigravity-cli',
      state: 'not_installed',
      evidence: ['agy executable not found on PATH'],
      paths: checked,
    };
  }

  const loaded = await readConfigFile(paths.mcpConfigPath);
  if (loaded.error) {
    return {
      id: 'antigravity-cli',
      state: 'configuration_error',
      evidence: [`MCP config at ${loaded.path} is not valid JSON: ${loaded.error.message}`],
      paths: checked,
      parseError: { file: loaded.path, message: loaded.error.message },
    };
  }

  if (!loaded.exists) {
    return {
      id: 'antigravity-cli',
      state: 'installed_not_configured',
      evidence: [`agy found at ${binary}`, `no MCP config at ${paths.mcpConfigPath}`],
      paths: checked,
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  const pluginPresent = existsSync(paths.pluginEntry);
  const evidence = [
    `agy found at ${binary}`,
    `MCP config: ${loaded.path}`,
    entry === undefined ? 'mcpServers.workjournal missing' : 'mcpServers.workjournal present',
    pluginPresent ? `plugin: ${paths.pluginEntry}` : `plugin missing: ${paths.pluginEntry}`,
  ];

  if (entry !== undefined && !isValidAntigravityCliEntry(entry)) {
    evidence.push('mcpServers.workjournal does not launch the MCP adapter correctly; re-run setup');
    return { id: 'antigravity-cli', state: 'installed_not_configured', evidence, paths: checked };
  }

  if (entry !== undefined) {
    return { id: 'antigravity-cli', state: 'configured', evidence, paths: checked };
  }
  return { id: 'antigravity-cli', state: 'installed_not_configured', evidence, paths: checked };
}
