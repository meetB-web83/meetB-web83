/**
 * Gemini CLI settings merge (plan §10.3–§10.4, D-021).
 *
 * Gemini CLI stores stdio servers as `mcpServers.<name>` with a `command`
 * string and `args` array under the top-level `mcpServers` key. Extensions
 * are installed under `~/.gemini/extensions/` (or `.gemini/extensions/` per
 * project) with a `gemini-extension.json` manifest.
 */

import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ConfigPlan, PlannedFile, SetupContext } from '../../types.js';
import {
  ensureTrailingNewline,
  getAtPath,
  isPlainObject,
  readConfigFile,
  removeJsoncValue,
  setJsoncValue,
  sha256Hex,
} from '../../safe-config.js';
import { isWorkjournalCommand, workjournalMcpCommand } from '../../command.js';
import { resolveGeminiCliPaths } from './discovery.js';
import { geminiCliPluginSource, geminiCliPluginVersion } from './plugin.generated.js';

export function desiredGeminiCliMcpEntry(): Record<string, unknown> {
  const command = workjournalMcpCommand();
  return {
    command: command[0],
    args: command.slice(1),
    disabled: false,
  };
}

async function plannedFile(filePath: string, content: string): Promise<PlannedFile> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (existing === content) {
    return { path: filePath, action: 'noop' };
  }
  return {
    path: filePath,
    action: existing === null ? 'create' : 'update',
    content,
  };
}

export async function planGeminiCli(ctx: SetupContext): Promise<ConfigPlan> {
  const paths = resolveGeminiCliPaths(ctx);
  const basePlan = { agentId: 'gemini-cli', scope: ctx.scope };
  const loaded = await readConfigFile(paths.settingsPath);
  const managedEntries: ConfigPlan['managedEntries'] = [];

  if (loaded.error) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.settingsPath}: the file is not valid JSON (${loaded.error.message}). The file was not modified.`,
    };
  }
  if (loaded.exists && !isPlainObject(loaded.data)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.settingsPath}: the top-level JSON value must be an object.`,
    };
  }

  const servers = getAtPath(loaded.data, ['mcpServers']);
  if (servers !== undefined && !isPlainObject(servers)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.settingsPath}: "mcpServers" must be an object.`,
    };
  }

  const existingEntry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  const existingTargetsWorkjournal =
    isPlainObject(existingEntry) && isWorkjournalCommand((existingEntry as any).command);

  if (existingEntry !== undefined && !existingTargetsWorkjournal && !ctx.force) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error:
        'An existing mcpServers.workjournal entry points at a different command. ' +
        'Re-run with --force to replace it.',
    };
  }

  const desired = existingTargetsWorkjournal
    ? {
        ...(existingEntry as Record<string, unknown>),
        command: workjournalMcpCommand()[0],
        args: workjournalMcpCommand().slice(1),
        disabled: (existingEntry as any).disabled ?? false,
      }
    : desiredGeminiCliMcpEntry();

  const text = setJsoncValue(loaded.exists ? loaded.text : '{\n}\n', ['mcpServers', 'workjournal'], desired);
  const configUnchanged = loaded.exists && text === loaded.text;

  const warnings: string[] = [];
  const files: PlannedFile[] = [
    configUnchanged
      ? { path: paths.settingsPath, action: 'noop' }
      : {
          path: paths.settingsPath,
          action: loaded.exists ? 'update' : 'create',
          content: text,
        },
  ];

  managedEntries.push({
    file: paths.settingsPath,
    key: 'mcpServers.workjournal',
    value: JSON.stringify(desired),
  });

  // One global extension instruments every workspace; a project copy would
  // make the same session emit duplicate lifecycle events.
  if (ctx.scope === 'global') {
    const pluginContent = ensureTrailingNewline(geminiCliPluginSource.trim());
    const pluginHash = sha256Hex(pluginContent);
    const manifestContent =
      JSON.stringify(
        {
          name: 'workjournal',
          version: geminiCliPluginVersion,
          description: 'WorkJournal lifecycle extension for Gemini CLI',
          main: 'index.js',
        },
        null,
        2,
      ) + '\n';

    const stagedDir = join(ctx.workjournalHome, 'integrations', 'gemini-cli', 'extension');
    const stagedEntry = join(stagedDir, 'index.js');
    const stagedManifest = join(stagedDir, 'manifest.json');

    files.push(
      await plannedFile(paths.pluginEntry, pluginContent),
      await plannedFile(paths.pluginManifest, manifestContent),
      await plannedFile(stagedEntry, pluginContent),
      await plannedFile(stagedManifest, manifestContent),
    );
    managedEntries.push(
      { file: paths.pluginEntry, key: 'plugin', value: paths.pluginEntry },
      { file: paths.pluginManifest, key: 'sha256', value: pluginHash },
      { file: stagedEntry, key: 'sha256', value: pluginHash },
    );
  } else {
    const globalExtension = resolveGeminiCliPaths({ ...ctx, scope: 'global' }).pluginEntry;
    if (!existsSync(globalExtension)) {
      warnings.push(
        `Lifecycle extension not installed at ${globalExtension}. ` +
          'Run `workjournal setup --agent gemini-cli --global` once; project setup does not duplicate it.',
      );
    }
  }

  return { ...basePlan, files, managedEntries, warnings };
}
