/**
 * Cursor discovery and path resolution (plan §10.3, D-021).
 *
 * Cursor keeps MCP servers at `~/.cursor/mcp.json` (global) or
 * `./.cursor/mcp.json` (project), under the `mcpServers` key. Cursor plugins
 * live in `~/.cursor/plugins/local/<plugin-name>/` (global) with a
 * `plugin.json` manifest plus hook configs and an ingest script. The binary
 * to detect is `cursor-agent` (CLI) or `cursor` (Cursor IDE CLI shim).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryResult, SetupEnv } from '../../types.js';
import { getAtPath, isPlainObject, readConfigFile } from '../../safe-config.js';
import { isWorkjournalCommand, resolveCommandPath } from '../../command.js';

export interface CursorPaths {
  scope: 'global' | 'project';
  settingsPath: string;
  settingsCandidates: string[];
  pluginDir: string;
  pluginPath: string;
  pluginCandidates: string[];
}

export function resolveCursorPaths(env: SetupEnv): CursorPaths {
  const scope = env.scope ?? 'global';
  const home = env.homeDir ?? homedir();
  const cursorDir = join(home, '.cursor');
  const settingsPath =
    process.env.CURSOR_MCP_SETTINGS_PATH?.trim() ||
    (scope === 'project'
      ? join(env.cwd, '.cursor', 'mcp.json')
      : join(cursorDir, 'mcp.json'));

  const pluginDir = join(home, '.cursor', 'plugins', 'local', 'workjournal');
  const pluginPath = join(pluginDir, 'plugin.json');

  return {
    scope,
    settingsPath,
    settingsCandidates: [settingsPath],
    pluginDir,
    pluginPath,
    pluginCandidates: [pluginPath, join(pluginDir, 'hooks', 'workjournal-hooks.json'), join(pluginDir, 'hooks', 'ingest.js')],
  };
}

/** True when the entry launches the WorkJournal MCP adapter via stdio. */
export function isValidCursorEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = (entry as any).command;
  if (typeof command !== 'string' || !isWorkjournalCommand(command)) return false;
  const args = Array.isArray((entry as any).args)
    ? (entry as any).args.filter((part: unknown) => typeof part === 'string')
    : [];
  const type = (entry as any).type;
  return type === 'stdio' || type === undefined || args.includes('mcp') || /\bmcp\b/.test(command);
}

export async function discoverCursor(env: SetupEnv): Promise<DiscoveryResult> {
  const paths = resolveCursorPaths(env);
  const binary = resolveCommandPath('cursor-agent') ?? resolveCommandPath('cursor');
  const checked = [...paths.settingsCandidates, ...paths.pluginCandidates];

  if (!binary) {
    return {
      id: 'cursor',
      state: 'not_installed',
      evidence: ['cursor-agent or cursor executable not found on PATH'],
      paths: checked,
    };
  }

  const loaded = await readConfigFile(paths.settingsPath);
  if (loaded.error) {
    return {
      id: 'cursor',
      state: 'configuration_error',
      evidence: [`settings at ${loaded.path} are not valid JSON: ${loaded.error.message}`],
      paths: checked,
      parseError: { file: loaded.path, message: loaded.error.message },
    };
  }

  if (!loaded.exists) {
    return {
      id: 'cursor',
      state: 'installed_not_configured',
      evidence: [`cursor found at ${binary}`, `no MCP settings file at ${paths.settingsPath}`],
      paths: checked,
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  const pluginPresent = paths.pluginCandidates.some((p) => existsSync(p));
  const evidence = [
    `cursor found at ${binary}`,
    `settings: ${loaded.path}`,
    entry === undefined ? 'mcpServers.workjournal missing' : 'mcpServers.workjournal present',
    pluginPresent ? `plugin: ${paths.pluginPath}` : `plugin missing: ${paths.pluginPath}`,
  ];

  if (entry !== undefined && !isValidCursorEntry(entry)) {
    evidence.push('mcpServers.workjournal does not launch the MCP adapter correctly; re-run setup');
    return { id: 'cursor', state: 'installed_not_configured', evidence, paths: checked };
  }

  if (entry !== undefined && pluginPresent) {
    return { id: 'cursor', state: 'configured', evidence, paths: checked };
  }
  return { id: 'cursor', state: 'installed_not_configured', evidence, paths: checked };
}