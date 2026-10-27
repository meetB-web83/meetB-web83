/**
 * Cline agent integration (plan §10.2–§10.5, D-021/D-022).
 *
 * Symmetrical to the OpenCode adapter, but writes Cline's `mcpServers` map and
 * installs an AgentExtension package under Cline's plugin directory.
 */

import { join } from 'node:path';
import { promises as fs } from 'node:fs';
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
  fileExists,
  getAtPath,
  isPlainObject,
  messageFor,
  parseJsonc,
  readConfigFile,
  removeFileIfExists,
  removeJsoncValue,
  restoreFromBackup,
  writeManagedFile,
} from '../../safe-config.js';
import { workjournalMcpCommand } from '../../command.js';
import { discoverCline, isValidClineEntry, resolveClinePaths } from './discovery.js';
import { planCline } from './merge.js';

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

async function validateCline(ctx: SetupContext) {
  const paths = resolveClinePaths(ctx);
  const loaded = await readConfigFile(paths.settingsPath);
  const details: string[] = [];

  if (!loaded.exists) {
    return { agentId: 'cline', valid: false, details: [`settings file not found: ${paths.settingsPath}`] };
  }
  if (loaded.error) {
    return {
      agentId: 'cline',
      valid: false,
      details: [`settings are not valid JSON: ${loaded.error.message}`],
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  let configValid = true;
  if (!isValidClineEntry(entry)) {
    details.push('mcpServers.workjournal does not launch the WorkJournal MCP adapter');
    configValid = false;
  } else {
    details.push('mcpServers.workjournal configured');
    const expected = workjournalMcpCommand();
    const actual = [(entry as any).command, ...((entry as any).args ?? [])];
    if (!deepEqual(actual, expected)) {
      details.push('mcpServers.workjournal command differs from the current executable; re-run setup to refresh');
    }
  }

  let pluginPresent = await fileExists(paths.pluginEntry);
  if (!pluginPresent && ctx.scope === 'project') {
    const globalPlugin = resolveClinePaths({ ...ctx, scope: 'global' }).pluginEntry;
    pluginPresent = await fileExists(globalPlugin);
    if (pluginPresent) details.push(`plugin present (global): ${globalPlugin}`);
  }
  if (!pluginPresent) {
    details.push(`plugin missing: ${paths.pluginEntry}`);
  } else if (ctx.scope === 'global') {
    details.push(`plugin present: ${paths.pluginEntry}`);
  }

  const valid = configValid && (ctx.scope === 'project' || pluginPresent);
  return { agentId: 'cline', valid, details };
}

function pruneEmptyServers(text: string): string {
  const servers = getAtPath(parseJsonc(text).data, ['mcpServers']);
  if (isPlainObject(servers) && Object.keys(servers).length === 0) {
    return removeJsoncValue(text, ['mcpServers']);
  }
  return text;
}

export const clineIntegration: AgentIntegration = {
  id: 'cline',
  displayName: 'Cline',
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    mcp: true,
    lifecyclePlugin: true,
    hooks: ['run-started', 'run-finished', 'run-failed'],
  },

  discover(env: SetupEnv): Promise<DiscoveryResult> {
    return discoverCline(env);
  },

  plan(ctx: SetupContext): Promise<ConfigPlan> {
    return planCline(ctx);
  },

  async apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult> {
    if (plan.error) {
      return { agentId: 'cline', success: false, filesModified: [], error: plan.error };
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
        agentId: 'cline',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Write failed: ${messageFor(err)}. Changes were rolled back.`,
      };
    }

    const validation = await validateCline(ctx);
    if (!validation.valid) {
      await rollback(written);
      return {
        agentId: 'cline',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Validation failed: ${validation.details.join('; ')}. Changes were rolled back.`,
      };
    }

    return {
      agentId: 'cline',
      success: true,
      filesModified: written.map((file) => file.path),
      backups: written.flatMap((file) => (file.backup ? [file.backup] : [])),
    };
  },

  validate(ctx: SetupContext) {
    return validateCline(ctx);
  },

  async uninstall(ctx: SetupContext): Promise<ApplyResult> {
    const paths = resolveClinePaths(ctx);
    const loaded = await readConfigFile(paths.settingsPath);
    const filesModified: string[] = [];
    const backups: string[] = [];

    if (loaded.exists) {
      if (loaded.error) {
        return {
          agentId: 'cline',
          success: false,
          filesModified,
          error: `Cannot update ${paths.settingsPath}: ${loaded.error.message}. The file was not modified.`,
        };
      }

      if (getAtPath(loaded.data, ['mcpServers', 'workjournal']) !== undefined) {
        let text = removeJsoncValue(loaded.text, ['mcpServers', 'workjournal']);
        text = pruneEmptyServers(text);
        if (text !== loaded.text) {
          const backup = await backupFile(paths.settingsPath);
          if (backup) backups.push(backup);
          await atomicWrite(paths.settingsPath, text);
          filesModified.push(paths.settingsPath);
        }
      }
    }

    const stagedDir = join(ctx.workjournalHome, 'integrations', 'cline', 'plugin');
    const removable = [paths.pluginEntry, paths.pluginManifest];
    if (ctx.scope === 'global') {
      removable.push(join(stagedDir, 'index.js'), join(stagedDir, 'manifest.json'));
    }
    for (const file of removable) {
      if (await removeFileIfExists(file)) filesModified.push(file);
    }
    await fs.rmdir(paths.pluginPackageDir).catch(() => undefined);
    if (ctx.scope === 'global') {
      await fs.rmdir(stagedDir).catch(() => undefined);
    }

    return { agentId: 'cline', success: true, filesModified, backups };
  },
};
