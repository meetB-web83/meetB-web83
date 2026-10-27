/**
 * Cline discovery and path resolution (plan §10.3, D-021).
 *
 * Cline 3.x keeps MCP settings at `~/.cline/data/settings/cline_mcp_settings.json`
 * (override: CLINE_MCP_SETTINGS_PATH) under the `mcpServers` key, and discovers
 * plugins from `~/.cline/plugins` or `<workspace>/.cline/plugins`. Older builds
 * also left a `~/.cline/mcp.json` file, which is only reported as evidence.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryResult, SetupEnv } from '../../types.js';
import { getAtPath, isPlainObject, readConfigFile } from '../../safe-config.js';
import { isWorkjournalCommand, resolveCommandPath } from '../../command.js';

export interface ClinePaths {
  scope: 'global' | 'project';
  settingsPath: string;
  settingsCandidates: string[];
  legacyConfigPaths: string[];
  pluginDir: string;
  pluginPackageDir: string;
  pluginEntry: string;
  pluginManifest: string;
}

export function resolveClinePaths(env: SetupEnv): ClinePaths {
  const scope = env.scope ?? 'global';
  const home = env.homeDir ?? homedir();
  const clineDir = join(home, '.cline');
  const settingsPath =
    process.env.CLINE_MCP_SETTINGS_PATH?.trim() ||
    join(clineDir, 'data', 'settings', 'cline_mcp_settings.json');
  const pluginDir = scope === 'project' ? join(env.cwd, '.cline', 'plugins') : join(clineDir, 'plugins');
  const pluginPackageDir = join(pluginDir, 'workjournal');

  return {
    scope,
    settingsPath,
    settingsCandidates: [settingsPath],
    legacyConfigPaths: [join(clineDir, 'mcp.json')],
    pluginDir,
    pluginPackageDir,
    pluginEntry: join(pluginPackageDir, 'index.js'),
    pluginManifest: join(pluginPackageDir, 'package.json'),
  };
}

/** True when the entry launches the WorkJournal MCP adapter with `mcp` args. */
export function isValidClineEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = (entry as any).command;
  if (typeof command !== 'string' || !isWorkjournalCommand(command)) return false;
  const args = Array.isArray((entry as any).args)
    ? (entry as any).args.filter((part: unknown) => typeof part === 'string')
    : [];
  if (args.includes('mcp')) return true;
  return /\bmcp\b/.test(command);
}

export async function discoverCline(env: SetupEnv): Promise<DiscoveryResult> {
  const paths = resolveClinePaths(env);
  const binary = resolveCommandPath('cline');
  const checked = [...paths.settingsCandidates, ...paths.legacyConfigPaths, paths.pluginEntry];

  if (!binary) {
    return {
      id: 'cline',
      state: 'not_installed',
      evidence: ['cline executable not found on PATH'],
      paths: checked,
    };
  }

  const loaded = await readConfigFile(paths.settingsPath);
  if (loaded.error) {
    return {
      id: 'cline',
      state: 'configuration_error',
      evidence: [`settings at ${loaded.path} are not valid JSON: ${loaded.error.message}`],
      paths: checked,
      parseError: { file: loaded.path, message: loaded.error.message },
    };
  }

  if (!loaded.exists) {
    return {
      id: 'cline',
      state: 'installed_not_configured',
      evidence: [`cline found at ${binary}`, `no MCP settings file at ${paths.settingsPath}`],
      paths: checked,
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  const pluginPresent = existsSync(paths.pluginEntry);
  const evidence = [
    `cline found at ${binary}`,
    `settings: ${loaded.path}`,
    entry === undefined ? 'mcpServers.workjournal missing' : 'mcpServers.workjournal present',
    pluginPresent ? `plugin: ${paths.pluginEntry}` : `plugin missing: ${paths.pluginEntry}`,
  ];

  const legacyLoaded = await readConfigFile(paths.legacyConfigPaths[0]);
  if (!legacyLoaded.error && getAtPath(legacyLoaded.data, ['mcpServers', 'workjournal']) !== undefined) {
    evidence.push(`legacy entry in ${paths.legacyConfigPaths[0]} is not used by the CLI`);
  }

  if (entry !== undefined && !isValidClineEntry(entry)) {
    evidence.push('mcpServers.workjournal does not launch the MCP adapter correctly; re-run setup');
    return { id: 'cline', state: 'installed_not_configured', evidence, paths: checked };
  }

  if (entry !== undefined) {
    return { id: 'cline', state: 'configured', evidence, paths: checked };
  }
  return { id: 'cline', state: 'installed_not_configured', evidence, paths: checked };
}
