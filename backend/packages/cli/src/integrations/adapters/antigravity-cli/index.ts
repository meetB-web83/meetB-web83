/**
 * Antigravity CLI agent integration (plan §10.2–§10.5, D-021/D-022).
 *
 * Writes `mcpServers.workjournal` into Antigravity CLI's standalone
 * `mcp_config.json` profile and installs a lifecycle plugin under
 * `~/.gemini/config/plugins/workjournal/` (global) or
 * `.agents/plugins/workjournal/` (project). The plugin observes Antigravity
 * CLI session lifecycle and tool events and POSTs canonical ledger envelopes
 * to Core's POST /api/ingest/events. This adapter wires discovery, the JSON
 * merge planner, plugin installation, validation, rollback, and uninstall
 * into the AgentIntegration interface.
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
  readConfigFile,
  removeFileIfExists,
  removeJsoncValue,
  restoreFromBackup,
  writeManagedFile,
} from '../../safe-config.js';
import { workjournalMcpCommand } from '../../command.js';
import {
  discoverAntigravityCli,
  isValidAntigravityCliEntry,
  resolveAntigravityCliPaths,
} from './discovery.js';
import { planAntigravityCli } from './merge.js';

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

async function validateAntigravityCli(ctx: SetupContext) {
  const paths = resolveAntigravityCliPaths(ctx);
  const loaded = await readConfigFile(paths.mcpConfigPath);
  const details: string[] = [];

  if (!loaded.exists) {
    return {
      agentId: 'antigravity-cli',
      valid: false,
      details: [`MCP config not found: ${paths.mcpConfigPath}`],
    };
  }
  if (loaded.error) {
    return {
      agentId: 'antigravity-cli',
      valid: false,
      details: [`MCP config is not valid JSON: ${loaded.error.message}`],
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  let configValid = true;
  if (!isValidAntigravityCliEntry(entry)) {
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

  // The plugin lives in the global scope; a project setup reuses it rather
  // than instrumenting the same session twice.
  let pluginPresent = await fileExists(paths.pluginEntry);
  if (!pluginPresent && ctx.scope === 'project') {
    const globalPlugin = resolveAntigravityCliPaths({ ...ctx, scope: 'global' }).pluginEntry;
    pluginPresent = await fileExists(globalPlugin);
    if (pluginPresent) details.push(`plugin present (global): ${globalPlugin}`);
  }
  if (!pluginPresent) {
    details.push(`plugin missing: ${paths.pluginEntry}`);
  } else if (ctx.scope === 'global') {
    details.push(`plugin present: ${paths.pluginEntry}`);
  }

  const valid = configValid && (ctx.scope === 'project' || pluginPresent);
  return { agentId: 'antigravity-cli', valid, details };
}

export const antigravityCliIntegration: AgentIntegration = {
  id: 'antigravity-cli',
  displayName: 'Antigravity CLI',
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    mcp: true,
    lifecyclePlugin: true,
    hooks: ['session.start', 'session.end', 'tool.call', 'tool.result', 'error'],
  },

  discover(env: SetupEnv): Promise<DiscoveryResult> {
    return discoverAntigravityCli(env);
  },

  plan(ctx: SetupContext): Promise<ConfigPlan> {
    return planAntigravityCli(ctx);
  },

  async apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult> {
    if (plan.error) {
      return { agentId: 'antigravity-cli', success: false, filesModified: [], error: plan.error };
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
        agentId: 'antigravity-cli',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Write failed: ${messageFor(err)}. Changes were rolled back.`,
      };
    }

    const validation = await validateAntigravityCli(ctx);
    if (!validation.valid) {
      await rollback(written);
      return {
        agentId: 'antigravity-cli',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Validation failed: ${validation.details.join('; ')}. Changes were rolled back.`,
      };
    }

    return {
      agentId: 'antigravity-cli',
      success: true,
      filesModified: written.map((file) => file.path),
      backups: written.flatMap((file) => (file.backup ? [file.backup] : [])),
    };
  },

  validate(ctx: SetupContext) {
    return validateAntigravityCli(ctx);
  },

  async uninstall(ctx: SetupContext): Promise<ApplyResult> {
    const paths = resolveAntigravityCliPaths(ctx);
    const loaded = await readConfigFile(paths.mcpConfigPath);
    const filesModified: string[] = [];
    const backups: string[] = [];

    if (loaded.exists) {
      if (loaded.error) {
        return {
          agentId: 'antigravity-cli',
          success: false,
          filesModified,
          error: `Cannot update ${paths.mcpConfigPath}: ${loaded.error.message}. The file was not modified.`,
        };
      }

      if (getAtPath(loaded.data, ['mcpServers', 'workjournal']) !== undefined) {
        let text = removeJsoncValue(loaded.text, ['mcpServers', 'workjournal']);
        // prune empty mcpServers object
        const servers = getAtPath(JSON.parse(text || '{}'), ['mcpServers']);
        if (isPlainObject(servers) && Object.keys(servers).length === 0) {
          text = removeJsoncValue(text, ['mcpServers']);
        }
        if (text !== loaded.text) {
          const backup = await backupFile(paths.mcpConfigPath);
          if (backup) backups.push(backup);
          await atomicWrite(paths.mcpConfigPath, text);
          filesModified.push(paths.mcpConfigPath);
        }
      }
    }

    // Remove plugin artifacts when uninstalling globally.
    if (ctx.scope === 'global') {
      const stagedDir = join(ctx.workjournalHome, 'integrations', 'antigravity-cli', 'plugin');
      const removable = [paths.pluginEntry, join(stagedDir, 'index.js'), join(stagedDir, 'manifest.json')];
      for (const file of removable) {
        if (await removeFileIfExists(file)) filesModified.push(file);
      }
      try {
        await fs.rm(paths.pluginsDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }

    return { agentId: 'antigravity-cli', success: true, filesModified, backups };
  },
};
