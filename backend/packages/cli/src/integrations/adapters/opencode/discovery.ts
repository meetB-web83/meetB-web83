/**
 * OpenCode discovery and path resolution (plan §10.3, D-021).
 *
 * OpenCode reads a global config from `<config>/opencode.json(c)` and
 * auto-loads plugin files from `<config>/plugins/`. Project scope uses
 * `opencode.json(c)` in the workspace root and `.opencode/plugins/`.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiscoveryResult, SetupEnv } from '../../types.js';
import { readConfigFile, getAtPath, isPlainObject } from '../../safe-config.js';
import { resolveCommandPath, isWorkjournalCommand } from '../../command.js';

export interface OpencodePaths {
  scope: 'global' | 'project';
  configDir: string;
  configCandidates: string[];
  /** Existing config if present, else the file setup will create. */
  configPath: string;
  pluginDir: string;
  pluginPath: string;
}

function configBase(env: SetupEnv): string {
  const home = env.homeDir ?? homedir();
  if (env.platform === 'win32') return join(home, '.config');
  return process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
}

/**
 * OpenCode reads the project config from the repository root, not the cwd:
 * running it in a subdirectory still loads `<git-root>/opencode.json` plus
 * `<git-root>/.opencode/`. Mirror that so `--project` edits the file the agent
 * actually reads.
 */
export function resolveOpencodeProjectRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

export function resolveOpencodePaths(env: SetupEnv): OpencodePaths {
  const scope = env.scope ?? 'global';
  if (scope === 'project') {
    const root = resolveOpencodeProjectRoot(env.cwd);
    const candidates = [join(root, 'opencode.jsonc'), join(root, 'opencode.json')];
    const configPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[1];
    const pluginDir = join(root, '.opencode', 'plugins');
    return {
      scope,
      configDir: root,
      configCandidates: candidates,
      configPath,
      pluginDir,
      pluginPath: join(pluginDir, 'workjournal.js'),
    };
  }

  const configDir = join(configBase(env), 'opencode');
  const candidates = [join(configDir, 'opencode.jsonc'), join(configDir, 'opencode.json')];
  const configPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[1];
  const pluginDir = join(configDir, 'plugins');
  return {
    scope,
    configDir,
    configCandidates: candidates,
    configPath,
    pluginDir,
    pluginPath: join(pluginDir, 'workjournal.js'),
  };
}

export async function discoverOpencode(env: SetupEnv): Promise<DiscoveryResult> {
  const paths = resolveOpencodePaths(env);
  const binary = resolveCommandPath('opencode');
  const checked = [...paths.configCandidates, paths.pluginPath];

  if (!binary) {
    return {
      id: 'opencode',
      state: 'not_installed',
      evidence: ['opencode executable not found on PATH'],
      paths: checked,
    };
  }

  const loaded = await readConfigFile(paths.configPath);
  if (!loaded.exists) {
    return {
      id: 'opencode',
      state: 'installed_not_configured',
      evidence: [`opencode found at ${binary}`, `no config file at ${paths.configPath}`],
      paths: checked,
    };
  }
  if (loaded.error) {
    return {
      id: 'opencode',
      state: 'configuration_error',
      evidence: [`config at ${loaded.path} is not valid JSONC: ${loaded.error.message}`],
      paths: checked,
      parseError: { file: loaded.path, message: loaded.error.message },
    };
  }

  const current = getAtPath(loaded.data, ['mcp', 'servers', 'workjournal']);
  const legacyFlat = getAtPath(loaded.data, ['mcp', 'workjournal']);
  const pluginPresent = existsSync(paths.pluginPath);
  const evidence = [
    `opencode found at ${binary}`,
    `config: ${loaded.path}`,
    current ? 'mcp.servers.workjournal configured' : 'mcp.servers.workjournal missing',
    pluginPresent ? `plugin: ${paths.pluginPath}` : `plugin missing: ${paths.pluginPath}`,
  ];
  if (legacyFlat) evidence.push('legacy mcp.workjournal found; re-run setup to migrate');

  if (isPlainObject(current)) {
    if (isWorkjournalCommand((current as any).command)) {
      return { id: 'opencode', state: 'configured', evidence, paths: checked };
    }
    evidence.push('mcp.servers.workjournal does not launch WorkJournal; re-run setup');
  }
  return {
    id: 'opencode',
    state: 'installed_not_configured',
    evidence,
    paths: checked,
  };
}
