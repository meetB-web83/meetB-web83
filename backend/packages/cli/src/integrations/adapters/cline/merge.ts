/**
 * Cline MCP settings merge (plan §10.3–§10.4, D-021).
 *
 * Cline stores stdio servers as `mcpServers.<name>` with a `command` string
 * and `args` array. Plugins are package directories discovered under
 * `~/.cline/plugins` (or `<workspace>/.cline/plugins`); a package.json with
 * `cline.plugins[].paths` points the loader at the ESM entry file.
 */

import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ConfigPlan, PlannedFile, SetupContext } from '../../types.js';
import {
  ensureTrailingNewline,
  getAtPath,
  isPlainObject,
  readConfigFile,
  sha256Hex,
  setJsoncValue,
} from '../../safe-config.js';
import { isWorkjournalCommand, workjournalMcpCommand } from '../../command.js';
import { resolveClinePaths } from './discovery.js';
import { clinePluginSource, clinePluginVersion } from './plugin.generated.js';

export function desiredClineMcpEntry(): Record<string, unknown> {
  const command = workjournalMcpCommand();
  return {
    command: command[0],
    args: command.slice(1),
    disabled: false,
    autoApprove: [],
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

export async function planCline(ctx: SetupContext): Promise<ConfigPlan> {
  const paths = resolveClinePaths(ctx);
  const basePlan = { agentId: 'cline', scope: ctx.scope };
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
        autoApprove: Array.isArray((existingEntry as any).autoApprove)
          ? (existingEntry as any).autoApprove
          : [],
      }
    : desiredClineMcpEntry();

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

  // One global plugin instruments every workspace; a project copy would make
  // the same session emit duplicate lifecycle events.
  if (ctx.scope === 'global') {
    const pluginContent = ensureTrailingNewline(clinePluginSource.trim());
    const pluginHash = sha256Hex(pluginContent);
    const manifestContent =
      JSON.stringify(
        {
          agent: 'cline',
          plugin: 'workjournal',
          version: clinePluginVersion,
          sha256: pluginHash,
        },
        null,
        2,
      ) + '\n';
    const packageContent =
      JSON.stringify(
        {
          name: 'workjournal-cline-plugin',
          version: clinePluginVersion,
          private: true,
          type: 'module',
          cline: { plugins: [{ paths: ['index.js'] }] },
        },
        null,
        2,
      ) + '\n';
    const stagedDir = join(ctx.workjournalHome, 'integrations', 'cline', 'plugin');
    const stagedIndex = join(stagedDir, 'index.js');
    const stagedManifest = join(stagedDir, 'manifest.json');

    files.push(
      await plannedFile(paths.pluginEntry, pluginContent),
      await plannedFile(paths.pluginManifest, packageContent),
      await plannedFile(stagedIndex, pluginContent),
      await plannedFile(stagedManifest, manifestContent),
    );
    managedEntries.push(
      { file: paths.pluginEntry, key: 'plugin', value: paths.pluginEntry },
      { file: stagedIndex, key: 'sha256', value: pluginHash },
    );
  } else {
    const globalPlugin = resolveClinePaths({ ...ctx, scope: 'global' }).pluginEntry;
    if (!existsSync(globalPlugin)) {
      warnings.push(
        `Lifecycle plugin not installed at ${globalPlugin}. ` +
          'Run `workjournal setup --agent cline --global` once; project setup does not duplicate it.',
      );
    }
  }

  return { ...basePlan, files, managedEntries, warnings };
}
