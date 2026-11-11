/**
 * Gemini CLI agent integration (plan §10.2–§10.5, D-021/D-022).
 *
 * Writes `mcpServers.workjournal` into Gemini CLI's `settings.json` and
 * installs a lifecycle extension under `~/.gemini/extensions/workjournal/`
 * (global) or `.gemini/extensions/workjournal/` (project). The extension
 * observes Gemini CLI session lifecycle and tool events and POSTs canonical
 * ledger envelopes to Core's POST /api/ingest/events. This adapter wires
 * discovery, the JSON merge planner, extension installation, validation,
 * rollback, and uninstall into the AgentIntegration interface.
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
import { discoverGeminiCli, isValidGeminiCliEntry, resolveGeminiCliPaths } from './discovery.js';
import { planGeminiCli } from './merge.js';

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

async function validateGeminiCli(ctx: SetupContext) {
  const paths = resolveGeminiCliPaths(ctx);
  const loaded = await readConfigFile(paths.settingsPath);
  const details: string[] = [];

  if (!loaded.exists) {
    return { agentId: 'gemini-cli', valid: false, details: [`settings file not found: ${paths.settingsPath}`] };
  }
  if (loaded.error) {
    return {
      agentId: 'gemini-cli',
      valid: false,
      details: [`settings are not valid JSON: ${loaded.error.message}`],
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  let configValid = true;
  if (!isValidGeminiCliEntry(entry)) {
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

  // The extension lives in the global scope; a project setup reuses it rather
  // than instrumenting the same session twice.
  let extensionPresent = await fileExists(paths.pluginEntry);
  if (!extensionPresent && ctx.scope === 'project') {
    const globalExtension = resolveGeminiCliPaths({ ...ctx, scope: 'global' }).pluginEntry;
    extensionPresent = await fileExists(globalExtension);
    if (extensionPresent) details.push(`extension present (global): ${globalExtension}`);
  }
  if (!extensionPresent) {
    details.push(`extension missing: ${paths.pluginEntry}`);
  } else if (ctx.scope === 'global') {
    details.push(`extension present: ${paths.pluginEntry}`);
  }

  const valid = configValid && (ctx.scope === 'project' || extensionPresent);
  return { agentId: 'gemini-cli', valid, details };
}

export const geminiCliIntegration: AgentIntegration = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    mcp: true,
    lifecyclePlugin: true,
    hooks: ['session.start', 'session.end', 'tool.call', 'tool.result', 'error'],
  },

  discover(env: SetupEnv): Promise<DiscoveryResult> {
    return discoverGeminiCli(env);
  },

  plan(ctx: SetupContext): Promise<ConfigPlan> {
    return planGeminiCli(ctx);
  },

  async apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult> {
    if (plan.error) {
      return { agentId: 'gemini-cli', success: false, filesModified: [], error: plan.error };
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
        agentId: 'gemini-cli',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Write failed: ${messageFor(err)}. Changes were rolled back.`,
      };
    }

    const validation = await validateGeminiCli(ctx);
    if (!validation.valid) {
      await rollback(written);
      return {
        agentId: 'gemini-cli',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Validation failed: ${validation.details.join('; ')}. Changes were rolled back.`,
      };
    }

    return {
      agentId: 'gemini-cli',
      success: true,
      filesModified: written.map((file) => file.path),
      backups: written.flatMap((file) => (file.backup ? [file.backup] : [])),
    };
  },

  validate(ctx: SetupContext) {
    return validateGeminiCli(ctx);
  },

  async uninstall(ctx: SetupContext): Promise<ApplyResult> {
    const paths = resolveGeminiCliPaths(ctx);
    const loaded = await readConfigFile(paths.settingsPath);
    const filesModified: string[] = [];
    const backups: string[] = [];

    if (loaded.exists) {
      if (loaded.error) {
        return {
          agentId: 'gemini-cli',
          success: false,
          filesModified,
          error: `Cannot update ${paths.settingsPath}: ${loaded.error.message}. The file was not modified.`,
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
          const backup = await backupFile(paths.settingsPath);
          if (backup) backups.push(backup);
          await atomicWrite(paths.settingsPath, text);
          filesModified.push(paths.settingsPath);
        }
      }
    }

    // Remove extension artifacts when uninstalling globally.
    if (ctx.scope === 'global') {
      const stagedDir = join(ctx.workjournalHome, 'integrations', 'gemini-cli', 'extension');
      const removable = [
        paths.pluginEntry,
        paths.pluginManifest,
        join(stagedDir, 'index.js'),
        join(stagedDir, 'manifest.json'),
      ];
      for (const file of removable) {
        if (await removeFileIfExists(file)) filesModified.push(file);
      }
      try {
        await fs.rm(paths.extensionsDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }

    return { agentId: 'gemini-cli', success: true, filesModified, backups };
  },
};
