/**
 * Cursor agent integration (plan §10.2–§10.5, D-021/D-022).
 *
 * Cursor's integration surface is MCP stdio servers only (no lifecycle plugin
 * API). This adapter wires discovery, the JSONC merge planner, validation,
 * and uninstall into the AgentIntegration interface.
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
import { discoverCursor, isValidCursorEntry, resolveCursorPaths } from './discovery.js';
import { planCursor } from './merge.js';

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

async function validateCursor(ctx: SetupContext) {
  const paths = resolveCursorPaths(ctx);
  const loaded = await readConfigFile(paths.settingsPath);
  const details: string[] = [];

  if (!loaded.exists) {
    return { agentId: 'cursor', valid: false, details: [`settings file not found: ${paths.settingsPath}`] };
  }
  if (loaded.error) {
    return {
      agentId: 'cursor',
      valid: false,
      details: [`settings are not valid JSON: ${loaded.error.message}`],
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  let configValid = true;
  if (!isValidCursorEntry(entry)) {
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

  return { agentId: 'cursor', valid: configValid, details };
}

export const cursorIntegration: AgentIntegration = {
  id: 'cursor',
  displayName: 'Cursor',
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    mcp: true,
    lifecyclePlugin: false,
    hooks: [],
  },

  discover(env: SetupEnv): Promise<DiscoveryResult> {
    return discoverCursor(env);
  },

  plan(ctx: SetupContext): Promise<ConfigPlan> {
    return planCursor(ctx);
  },

  async apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult> {
    if (plan.error) {
      return { agentId: 'cursor', success: false, filesModified: [], error: plan.error };
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
        agentId: 'cursor',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Write failed: ${messageFor(err)}. Changes were rolled back.`,
      };
    }

    const validation = await validateCursor(ctx);
    if (!validation.valid) {
      await rollback(written);
      return {
        agentId: 'cursor',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Validation failed: ${validation.details.join('; ')}. Changes were rolled back.`,
      };
    }

    return {
      agentId: 'cursor',
      success: true,
      filesModified: written.map((file) => file.path),
      backups: written.flatMap((file) => (file.backup ? [file.backup] : [])),
    };
  },

  validate(ctx: SetupContext) {
    return validateCursor(ctx);
  },

  async uninstall(ctx: SetupContext): Promise<ApplyResult> {
    const paths = resolveCursorPaths(ctx);
    const loaded = await readConfigFile(paths.settingsPath);
    const filesModified: string[] = [];
    const backups: string[] = [];

    if (loaded.exists) {
      if (loaded.error) {
        return {
          agentId: 'cursor',
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

    return { agentId: 'cursor', success: true, filesModified, backups };
  },
};
