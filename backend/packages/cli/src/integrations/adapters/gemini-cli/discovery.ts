/**
 * Gemini CLI discovery and path resolution (plan §10.3, D-021).
 *
 * Gemini CLI keeps MCP settings in `settings.json` under the top-level
 * `mcpServers` key. User scope: `~/.gemini/settings.json`. Project scope:
 * `.gemini/settings.json` in the project root. System settings may live at
 * `/etc/gemini-cli/settings.json` (Linux), `C:\ProgramData\gemini-cli\settings.json`
 * (Windows), or `/Library/Application Support/GeminiCli/settings.json` (macOS),
 * overridable via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` — system settings are only
 * reported as evidence, never edited by setup.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryResult, SetupEnv } from '../../types.js';
import { readConfigFile, getAtPath, isPlainObject } from '../../safe-config.js';
import { resolveCommandPath, isWorkjournalCommand } from '../../command.js';

export interface GeminiCliPaths {
  scope: 'global' | 'project';
  settingsPath: string;
  settingsCandidates: string[];
  systemSettingsPaths: string[];
  extensionsDir: string;
  extensionDir: string;
  pluginEntry: string;
  pluginManifest: string;
}

function systemSettingsPaths(): string[] {
  const platform = process.platform;
  if (platform === 'win32') return [join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'gemini-cli', 'settings.json')];
  if (platform === 'darwin') return [join('/Library', 'Application Support', 'GeminiCli', 'settings.json')];
  return [join('/etc', 'gemini-cli', 'settings.json')];
}

export function resolveGeminiCliPaths(env: SetupEnv): GeminiCliPaths {
  const scope = env.scope ?? 'global';
  const home = env.homeDir ?? homedir();
  const geminiDir = join(home, '.gemini');
  const settingsPath = join(geminiDir, 'settings.json');

  const extensionsDir = scope === 'project' ? join(env.cwd, '.gemini', 'extensions') : join(geminiDir, 'extensions');
  const extensionDir = join(extensionsDir, 'workjournal');

  return {
    scope,
    settingsPath,
    settingsCandidates: [settingsPath],
    systemSettingsPaths: systemSettingsPaths(),
    extensionsDir,
    extensionDir,
    pluginEntry: join(extensionDir, 'index.js'),
    pluginManifest: join(extensionDir, 'gemini-extension.json'),
  };
}

/** True when the entry launches the WorkJournal MCP adapter with `mcp` args. */
export function isValidGeminiCliEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const command = (entry as any).command;
  if (typeof command !== 'string' || !isWorkjournalCommand(command)) return false;
  const args = Array.isArray((entry as any).args)
    ? (entry as any).args.filter((part: unknown) => typeof part === 'string')
    : [];
  if (args.includes('mcp')) return true;
  return /\bmcp\b/.test(command);
}

export async function discoverGeminiCli(env: SetupEnv): Promise<DiscoveryResult> {
  const paths = resolveGeminiCliPaths(env);
  const binary = resolveCommandPath('gemini');
  const checked = [...paths.settingsCandidates, ...paths.systemSettingsPaths, paths.pluginEntry];

  if (!binary) {
    return {
      id: 'gemini-cli',
      state: 'not_installed',
      evidence: ['gemini executable not found on PATH'],
      paths: checked,
    };
  }

  const loaded = await readConfigFile(paths.settingsPath);
  if (loaded.error) {
    return {
      id: 'gemini-cli',
      state: 'configuration_error',
      evidence: [`settings at ${loaded.path} are not valid JSON: ${loaded.error.message}`],
      paths: checked,
      parseError: { file: loaded.path, message: loaded.error.message },
    };
  }

  if (!loaded.exists) {
    return {
      id: 'gemini-cli',
      state: 'installed_not_configured',
      evidence: [`gemini found at ${binary}`, `no settings file at ${paths.settingsPath}`],
      paths: checked,
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  const pluginPresent = existsSync(paths.pluginEntry);
  const evidence = [
    `gemini found at ${binary}`,
    `settings: ${loaded.path}`,
    entry === undefined ? 'mcpServers.workjournal missing' : 'mcpServers.workjournal present',
    pluginPresent ? `extension: ${paths.pluginEntry}` : `extension missing: ${paths.pluginEntry}`,
  ];

  // System settings are read-only evidence; they are never edited by setup.
  for (const systemPath of paths.systemSettingsPaths) {
    const systemLoaded = await readConfigFile(systemPath);
    if (!systemLoaded.error && getAtPath(systemLoaded.data, ['mcpServers', 'workjournal']) !== undefined) {
      evidence.push(`system settings at ${systemPath} also define mcpServers.workjournal`);
    }
  }

  if (entry !== undefined && !isValidGeminiCliEntry(entry)) {
    evidence.push('mcpServers.workjournal does not launch the MCP adapter correctly; re-run setup');
    return { id: 'gemini-cli', state: 'installed_not_configured', evidence, paths: checked };
  }

  if (entry !== undefined) {
    return { id: 'gemini-cli', state: 'configured', evidence, paths: checked };
  }
  return { id: 'gemini-cli', state: 'installed_not_configured', evidence, paths: checked };
}
