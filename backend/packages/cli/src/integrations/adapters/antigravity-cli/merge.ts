/**
 * Antigravity CLI MCP config merge (plan §10.3–§10.4, D-021).
 *
 * Antigravity CLI stores stdio servers as `mcpServers.<name>` with a
 * `command` string and `args` array inside a standalone `mcp_config.json`
 * profile (global: `~/.gemini/config/mcp_config.json`, project:
 * `.agents/mcp_config.json`). Plugins live under
 * `~/.gemini/config/plugins/` (global) or `.agents/plugins/` (project).
 */

import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ConfigPlan, PlannedFile, SetupContext } from '../../types.js';
import {
  ensureTrailingNewline,
  getAtPath,
  isPlainObject,
  readConfigFile,
  setJsoncValue,
  sha256Hex,
} from '../../safe-config.js';
import { isWorkjournalCommand, workjournalMcpCommand } from '../../command.js';
import { resolveAntigravityCliPaths } from './discovery.js';
import { antigravityCliPluginSource, antigravityCliPluginVersion } from './plugin.generated.js';

export function desiredAntigravityCliMcpEntry(): Record<string, unknown> {
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

export async function planAntigravityCli(ctx: SetupContext): Promise<ConfigPlan> {
  const paths = resolveAntigravityCliPaths(ctx);
  const basePlan = { agentId: 'antigravity-cli', scope: ctx.scope };
  const loaded = await readConfigFile(paths.mcpConfigPath);
  const managedEntries: ConfigPlan['managedEntries'] = [];

  if (loaded.error) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.mcpConfigPath}: the file is not valid JSON (${loaded.error.message}). The file was not modified.`,
    };
  }
  if (loaded.exists && !isPlainObject(loaded.data)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.mcpConfigPath}: the top-level JSON value must be an object.`,
    };
  }

  const servers = getAtPath(loaded.data, ['mcpServers']);
  if (servers !== undefined && !isPlainObject(servers)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.mcpConfigPath}: "mcpServers" must be an object.`,
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
    : desiredAntigravityCliMcpEntry();

  const text = setJsoncValue(loaded.exists ? loaded.text : '{\n}\n', ['mcpServers', 'workjournal'], desired);
  const configUnchanged = loaded.exists && text === loaded.text;

  const warnings: string[] = [];
  const files: PlannedFile[] = [
    configUnchanged
      ? { path: paths.mcpConfigPath, action: 'noop' }
      : {
          path: paths.mcpConfigPath,
          action: loaded.exists ? 'update' : 'create',
          content: text,
        },
  ];

  managedEntries.push({
    file: paths.mcpConfigPath,
    key: 'mcpServers.workjournal',
    value: JSON.stringify(desired),
  });

  // One global plugin instruments every workspace; a project copy would
  // make the same session emit duplicate lifecycle events.
  if (ctx.scope === 'global') {
    const pluginContent = ensureTrailingNewline(antigravityCliPluginSource.trim());
    const pluginHash = sha256Hex(pluginContent);
    const manifestContent =
      JSON.stringify(
        {
          name: 'workjournal',
          version: antigravityCliPluginVersion,
          description: 'WorkJournal lifecycle plugin for Antigravity CLI',
          main: 'index.js',
        },
        null,
        2,
      ) + '\n';

    const stagedDir = join(ctx.workjournalHome, 'integrations', 'antigravity-cli', 'plugin');
    const stagedEntry = join(stagedDir, 'index.js');
    const stagedManifest = join(stagedDir, 'manifest.json');

    files.push(
      await plannedFile(paths.pluginEntry, pluginContent),
      await plannedFile(join(paths.pluginsDir, 'manifest.json'), manifestContent),
      await plannedFile(stagedEntry, pluginContent),
      await plannedFile(stagedManifest, manifestContent),
    );
    managedEntries.push(
      { file: paths.pluginEntry, key: 'plugin', value: paths.pluginEntry },
      { file: stagedEntry, key: 'sha256', value: pluginHash },
    );
  } else {
    const globalPlugin = resolveAntigravityCliPaths({ ...ctx, scope: 'global' }).pluginEntry;
    if (!existsSync(globalPlugin)) {
      warnings.push(
        `Lifecycle plugin not installed at ${globalPlugin}. ` +
          'Run `workjournal setup --agent antigravity-cli --global` once; project setup does not duplicate it.',
      );
    }
  }

  return { ...basePlan, files, managedEntries, warnings };
}
