/**
 * OpenCode agent integration (plan §10.2–§10.5, D-021/D-022).
 *
 * Wires discovery, the JSONC merge planner, plugin extraction, validation,
 * rollback, and uninstall into the AgentIntegration interface.
 */

import { join } from 'node:path';
import type {
  AgentIntegration,
  ApplyResult,
  ConfigPlan,
  DiscoveryResult,
  SetupContext,
  SetupEnv,
} from '../../types.js';
import {
  atomicWrite,
  backupFile,
  deepEqual,
  getAtPath,
  isPlainObject,
  messageFor,
  fileExists,
  readConfigFile,
  removeJsoncValue,
  removeFileIfExists,
  restoreFromBackup,
  setJsoncValue,
  writeManagedFile,
} from '../../safe-config.js';
import { isWorkjournalCommand, workjournalMcpCommand } from '../../command.js';
import { discoverOpencode, resolveOpencodePaths } from './discovery.js';
import { planOpencode, pruneEmptyParents } from './merge.js';

interface WrittenFile {
  path: string;
  backup: string | null;
  created: boolean;
}

async function rollback(files: WrittenFile[]): Promise<void> {
  for (const file of [...files].reverse()) {
    try {
      if (file.backup) {
        await restoreFromBackup(file.path, file.backup);
      } else if (file.created) {
        await removeFileIfExists(file.path);
      }
    } catch {
      /* keep restoring the remaining files */
    }
  }
}

function isOurLegacyPluginEntry(entry: unknown): boolean {
  const target =
    typeof entry === 'string'
      ? entry
      : isPlainObject(entry) && typeof entry.path === 'string'
        ? entry.path
        : '';
  return target.replace(/\\/g, '/').toLowerCase().includes('integrations/opencode/plugin');
}

export async function validateOpencode(ctx: SetupContext) {
  const paths = resolveOpencodePaths(ctx);
  const loaded = await readConfigFile(paths.configPath);
  const details: string[] = [];

  if (!loaded.exists) {
    return { agentId: 'opencode', valid: false, details: [`config file not found: ${paths.configPath}`] };
  }
  if (loaded.error) {
    return {
      agentId: 'opencode',
      valid: false,
      details: [`config is not valid JSONC: ${loaded.error.message}`],
    };
  }

  const entry = getAtPath(loaded.data, ['mcp', 'servers', 'workjournal']);
  let configValid = true;
  if (!isPlainObject(entry)) {
    details.push('mcp.servers.workjournal missing');
    configValid = false;
  } else {
    const command = (entry as any).command;
    if ((entry as any).type !== 'local') {
      details.push('mcp.servers.workjournal.type is not "local"');
      configValid = false;
    }
    if (
      !Array.isArray(command) ||
      command.length < 2 ||
      !command.every((part: unknown) => typeof part === 'string') ||
      !isWorkjournalCommand(command) ||
      !command.includes('mcp')
    ) {
      details.push('mcp.servers.workjournal.command does not launch the WorkJournal MCP adapter');
      configValid = false;
    } else {
      details.push('mcp.servers.workjournal configured');
      const expected = workjournalMcpCommand();
      if (!deepEqual(command, expected)) {
        details.push('mcp.servers.workjournal.command differs from the current executable; re-run setup to refresh');
      }
    }
  }

  // The plugin lives in the global scope; a project setup reuses it rather
  // than instrumenting the same session twice.
  let pluginPresent = await fileExists(paths.pluginPath);
  if (!pluginPresent && ctx.scope === 'project') {
    const globalPlugin = resolveOpencodePaths({ ...ctx, scope: 'global' }).pluginPath;
    pluginPresent = await fileExists(globalPlugin);
    if (pluginPresent) details.push(`plugin present (global): ${globalPlugin}`);
  }
  if (!pluginPresent) {
    details.push(`plugin missing: ${paths.pluginPath}`);
  } else if (ctx.scope === 'global') {
    details.push(`plugin present: ${paths.pluginPath}`);
  }

  const valid = configValid && (ctx.scope === 'project' || pluginPresent);
  return { agentId: 'opencode', valid, details };
}

export const opencodeIntegration: AgentIntegration = {
  id: 'opencode',
  displayName: 'OpenCode',
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    mcp: true,
    lifecyclePlugin: true,
    hooks: ['session.created', 'session.execution', 'session.deleted', 'session.idle', 'session.error'],
  },

  discover(env: SetupEnv): Promise<DiscoveryResult> {
    return discoverOpencode(env);
  },

  plan(ctx: SetupContext): Promise<ConfigPlan> {
    return planOpencode(ctx);
  },

  async apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult> {
    if (plan.error) {
      return { agentId: 'opencode', success: false, filesModified: [], error: plan.error };
    }

    const written: WrittenFile[] = [];
    try {
      for (const file of plan.files) {
        if (file.action === 'noop' || file.content === undefined) continue;
        const result = await writeManagedFile(file.path, file.content);
        if (result.action !== 'noop') {
          written.push({
            path: file.path,
            backup: result.backup,
            created: result.action === 'create',
          });
        }
      }
    } catch (err) {
      await rollback(written);
      return {
        agentId: 'opencode',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Write failed: ${messageFor(err)}. Changes were rolled back.`,
      };
    }

    const validation = await validateOpencode(ctx);
    if (!validation.valid) {
      await rollback(written);
      return {
        agentId: 'opencode',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Validation failed: ${validation.details.join('; ')}. Changes were rolled back.`,
      };
    }

    return {
      agentId: 'opencode',
      success: true,
      filesModified: written.map((file) => file.path),
      backups: written.flatMap((file) => (file.backup ? [file.backup] : [])),
    };
  },

  validate(ctx: SetupContext) {
    return validateOpencode(ctx);
  },

  async uninstall(ctx: SetupContext): Promise<ApplyResult> {
    const paths = resolveOpencodePaths(ctx);
    const loaded = await readConfigFile(paths.configPath);
    const filesModified: string[] = [];
    const backups: string[] = [];

    if (loaded.exists) {
      if (loaded.error) {
        return {
          agentId: 'opencode',
          success: false,
          filesModified,
          error: `Cannot update ${paths.configPath}: ${loaded.error.message}. The file was not modified.`,
        };
      }

      let text = loaded.text;
      let changed = false;

      if (getAtPath(loaded.data, ['mcp', 'workjournal']) !== undefined) {
        text = removeJsoncValue(text, ['mcp', 'workjournal']);
        text = pruneEmptyParents(text);
        changed = true;
      }
      if (getAtPath(loaded.data, ['mcp', 'servers', 'workjournal']) !== undefined) {
        text = removeJsoncValue(text, ['mcp', 'servers', 'workjournal']);
        text = pruneEmptyParents(text);
        changed = true;
      }

      const plugins = getAtPath(loaded.data, ['plugins']);
      if (Array.isArray(plugins)) {
        const filtered = plugins.filter((entry) => !isOurLegacyPluginEntry(entry));
        if (filtered.length !== plugins.length) {
          text =
            filtered.length === 0
              ? removeJsoncValue(text, ['plugins'])
              : setJsoncValue(text, ['plugins'], filtered);
          changed = true;
        }
      }

      if (changed && text !== loaded.text) {
        const backup = await backupFile(paths.configPath);
        if (backup) backups.push(backup);
        await atomicWrite(paths.configPath, text);
        filesModified.push(paths.configPath);
      }
    }

    const stagedDir = join(ctx.workjournalHome, 'integrations', 'opencode', 'plugin');
    const removable = [paths.pluginPath];
    if (ctx.scope === 'global') {
      removable.push(join(stagedDir, 'index.js'), join(stagedDir, 'manifest.json'));
    }
    for (const file of removable) {
      if (await removeFileIfExists(file)) filesModified.push(file);
    }

    return { agentId: 'opencode', success: true, filesModified, backups };
  },
};
