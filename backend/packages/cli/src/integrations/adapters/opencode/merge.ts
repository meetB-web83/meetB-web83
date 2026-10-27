/**
 * OpenCode config merge (plan §10.3–§10.4, D-021).
 *
 * Pure planning: reads the current file, computes the exact JSONC text and
 * plugin artifacts, and reports conflicts. `apply` performs the writes.
 *
 * The installed OpenCode schema maps MCP servers under `mcp.servers.<name>`
 * (verified against `opencode mcp add`), and auto-loads local plugins from
 * `<config>/plugins/` or `<project>/.opencode/plugins/`. The flat
 * `mcp.workjournal` shape and the legacy `plugins` array were written by an
 * earlier setup build; those managed leftovers are migrated/removed here
 * without touching unrelated entries.
 */

import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ConfigPlan, PlannedFile, SetupContext } from '../../types.js';
import {
  ensureTrailingNewline,
  getAtPath,
  isPlainObject,
  parseJsonc,
  readConfigFile,
  removeJsoncValue,
  setJsoncValue,
  sha256Hex,
} from '../../safe-config.js';
import { isWorkjournalCommand, workjournalMcpCommand } from '../../command.js';
import { resolveOpencodePaths } from './discovery.js';
import { opencodePluginSource, opencodePluginVersion } from './plugin.generated.js';

export function desiredOpencodeMcpEntry(): Record<string, unknown> {
  return { type: 'local', command: workjournalMcpCommand() };
}

function isOurLegacyPluginEntry(entry: unknown): boolean {
  const target =
    typeof entry === 'string'
      ? entry
      : isPlainObject(entry) && typeof entry.path === 'string'
        ? entry.path
        : '';
  if (!target) return false;
  const normalized = target.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('integrations/opencode/plugin');
}

export function pruneEmptyParents(text: string): string {
  const servers = getAtPath(parseJsonc(text).data, ['mcp', 'servers']);
  if (isPlainObject(servers) && Object.keys(servers).length === 0) {
    text = removeJsoncValue(text, ['mcp', 'servers']);
  }
  const mcp = getAtPath(parseJsonc(text).data, ['mcp']);
  if (isPlainObject(mcp) && Object.keys(mcp).length === 0) {
    text = removeJsoncValue(text, ['mcp']);
  }
  return text;
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

export async function planOpencode(ctx: SetupContext): Promise<ConfigPlan> {
  const paths = resolveOpencodePaths(ctx);
  const basePlan = { agentId: 'opencode', scope: ctx.scope };
  const loaded = await readConfigFile(paths.configPath);
  const managedEntries: ConfigPlan['managedEntries'] = [];

  if (loaded.error) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.configPath}: the file is not valid JSONC (${loaded.error.message}). The file was not modified.`,
    };
  }
  if (loaded.exists && !isPlainObject(loaded.data)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.configPath}: the top-level JSON value must be an object.`,
    };
  }

  const mcp = getAtPath(loaded.data, ['mcp']);
  if (mcp !== undefined && !isPlainObject(mcp)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.configPath}: "mcp" must be an object.`,
    };
  }
  const servers = getAtPath(loaded.data, ['mcp', 'servers']);
  if (servers !== undefined && !isPlainObject(servers)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.configPath}: "mcp.servers" must be an object.`,
    };
  }

  const existingEntry =
    getAtPath(loaded.data, ['mcp', 'servers', 'workjournal']) ??
    getAtPath(loaded.data, ['mcp', 'workjournal']);
  const legacyFlatEntry = getAtPath(loaded.data, ['mcp', 'workjournal']);
  const existingTargetsWorkjournal =
    isPlainObject(existingEntry) && isWorkjournalCommand((existingEntry as any).command);

  if (existingEntry !== undefined && !existingTargetsWorkjournal && !ctx.force) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error:
        `An existing mcp.servers.workjournal entry points at a different command. ` +
        `Re-run with --force to replace it.`,
    };
  }

  const preserved = isPlainObject(existingEntry) ? { ...(existingEntry as Record<string, unknown>) } : {};
  // `enabled` came from the flat shape this CLI no longer writes.
  delete preserved.enabled;
  const desired =
    existingEntry === undefined
      ? desiredOpencodeMcpEntry()
      : { ...preserved, type: 'local', command: workjournalMcpCommand() };

  let text = loaded.exists ? loaded.text : '{\n}\n';

  if (legacyFlatEntry !== undefined) {
    text = removeJsoncValue(text, ['mcp', 'workjournal']);
    text = pruneEmptyParents(text);
  }

  const legacyPlugins = getAtPath(loaded.data, ['plugins']);
  if (Array.isArray(legacyPlugins)) {
    const filtered = legacyPlugins.filter((entry) => !isOurLegacyPluginEntry(entry));
    if (filtered.length !== legacyPlugins.length) {
      text =
        filtered.length === 0
          ? removeJsoncValue(text, ['plugins'])
          : setJsoncValue(text, ['plugins'], filtered);
    }
  }

  text = setJsoncValue(text, ['mcp', 'servers', 'workjournal'], desired);
  const configUnchanged = loaded.exists && text === loaded.text;

  const warnings: string[] = [];
  const files: PlannedFile[] = [
    configUnchanged
      ? { path: paths.configPath, action: 'noop' }
      : {
          path: paths.configPath,
          action: loaded.exists ? 'update' : 'create',
          content: text,
        },
  ];

  managedEntries.push({
    file: paths.configPath,
    key: 'mcp.servers.workjournal',
    value: JSON.stringify(desired),
  });

  // The plugin is workspace-aware (it scopes events by the session directory),
  // so a single global copy covers every project. Installing a second copy
  // per project would instrument the same session twice.
  if (ctx.scope === 'global') {
    const pluginContent = ensureTrailingNewline(opencodePluginSource.trim());
    const pluginHash = sha256Hex(pluginContent);
    const stagedDir = join(ctx.workjournalHome, 'integrations', 'opencode', 'plugin');
    const stagedIndex = join(stagedDir, 'index.js');
    const stagedManifest = join(stagedDir, 'manifest.json');
    const manifestContent =
      JSON.stringify(
        {
          agent: 'opencode',
          plugin: 'workjournal',
          version: opencodePluginVersion,
          sha256: pluginHash,
        },
        null,
        2,
      ) + '\n';

    files.push(
      await plannedFile(paths.pluginPath, pluginContent),
      await plannedFile(stagedIndex, pluginContent),
      await plannedFile(stagedManifest, manifestContent),
    );
    managedEntries.push(
      { file: paths.pluginPath, key: 'plugin', value: paths.pluginPath },
      { file: stagedIndex, key: 'sha256', value: pluginHash },
    );
  } else {
    const globalPlugin = resolveOpencodePaths({ ...ctx, scope: 'global' }).pluginPath;
    if (!existsSync(globalPlugin)) {
      warnings.push(
        `Lifecycle plugin not installed at ${globalPlugin}. ` +
          'Run `workjournal setup --agent opencode --global` once; project setup does not duplicate it.',
      );
    }
  }

  return { ...basePlan, files, managedEntries, warnings };
}
