/**
 * Claude Code agent integration (plan §10.2–§10.5, D-021/D-022).
 *
 * Writes `mcpServers.workjournal` into Claude Code's `~/.claude.json` (user
 * scope) or `.mcp.json` (project scope), and registers lifecycle hooks in
 * `.claude/settings.json` that point at an ingest handler script. The hook
 * handler observes Claude Code session lifecycle and tool events (SessionStart,
 * SessionEnd, PreToolUse, PostToolUse, Stop, Notification) and POSTs canonical
 * ledger envelopes to Core's POST /api/ingest/events. This adapter wires
 * discovery, the JSON merge planner, hook installation, validation, rollback,
 * and uninstall into the AgentIntegration interface.
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
import { discoverClaudeCode, isValidClaudeCodeEntry, resolveClaudeCodePaths } from './discovery.js';
import { planClaudeCode } from './merge.js';

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

/** Remove the workjournal hook entry from Claude Code's hooks configuration. */
function stripWorkjournalHooks(text: string): string {
  try {
    const data = JSON.parse(text);
    if (!isPlainObject(data) || !Array.isArray(data.hooks)) return text;
    data.hooks = data.hooks.filter((h: unknown) => {
      if (!isPlainObject(h)) return true;
      const cmds = (h as any).hooks;
      if (!Array.isArray(cmds)) return true;
      return !cmds.some(
        (c: unknown) =>
          isPlainObject(c) &&
          typeof (c as any).command === 'string' &&
          ((c as any).command as string).includes('workjournal-ingest.js'),
      );
    });
    let result = JSON.stringify(data, null, 2) + '\n';
    if (!result.endsWith('\n')) result += '\n';
    return result;
  } catch {
    return text;
  }
}

async function validateClaudeCode(ctx: SetupContext) {
  const paths = resolveClaudeCodePaths(ctx);
  const loaded = await readConfigFile(paths.mcpPath);
  const details: string[] = [];

  if (!loaded.exists) {
    return { agentId: 'claude-code', valid: false, details: [`MCP settings not found: ${paths.mcpPath}`] };
  }
  if (loaded.error) {
    return {
      agentId: 'claude-code',
      valid: false,
      details: [`MCP settings are not valid JSON: ${loaded.error.message}`],
    };
  }

  const entry = getAtPath(loaded.data, ['mcpServers', 'workjournal']);
  let configValid = true;
  if (!isValidClaudeCodeEntry(entry)) {
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

  // The hook handler lives globally; a project setup reuses it.
  let handlerPresent = await fileExists(paths.hookHandler);
  if (!handlerPresent && ctx.scope === 'project') {
    const globalHandler = resolveClaudeCodePaths({ ...ctx, scope: 'global' }).hookHandler;
    handlerPresent = await fileExists(globalHandler);
    if (handlerPresent) details.push(`hook handler present (global): ${globalHandler}`);
  }
  if (!handlerPresent) {
    details.push(`hook handler missing: ${paths.hookHandler}`);
  } else if (ctx.scope === 'global') {
    details.push(`hook handler present: ${paths.hookHandler}`);
  }

  const valid = configValid && (ctx.scope === 'project' || handlerPresent);
  return { agentId: 'claude-code', valid, details };
}

export const claudeCodeIntegration: AgentIntegration = {
  id: 'claude-code',
  displayName: 'Claude Code',
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    mcp: true,
    lifecyclePlugin: true,
    hooks: ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'],
  },

  discover(env: SetupEnv): Promise<DiscoveryResult> {
    return discoverClaudeCode(env);
  },

  plan(ctx: SetupContext): Promise<ConfigPlan> {
    return planClaudeCode(ctx);
  },

  async apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult> {
    if (plan.error) {
      return { agentId: 'claude-code', success: false, filesModified: [], error: plan.error };
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
        agentId: 'claude-code',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Write failed: ${messageFor(err)}. Changes were rolled back.`,
      };
    }

    const validation = await validateClaudeCode(ctx);
    if (!validation.valid) {
      await rollback(written);
      return {
        agentId: 'claude-code',
        success: false,
        filesModified: written.map((file) => file.path),
        error: `Validation failed: ${validation.details.join('; ')}. Changes were rolled back.`,
      };
    }

    return {
      agentId: 'claude-code',
      success: true,
      filesModified: written.map((file) => file.path),
      backups: written.flatMap((file) => (file.backup ? [file.backup] : [])),
    };
  },

  validate(ctx: SetupContext) {
    return validateClaudeCode(ctx);
  },

  async uninstall(ctx: SetupContext): Promise<ApplyResult> {
    const paths = resolveClaudeCodePaths(ctx);
    const loaded = await readConfigFile(paths.mcpPath);
    const filesModified: string[] = [];
    const backups: string[] = [];

    if (loaded.exists) {
      if (loaded.error) {
        return {
          agentId: 'claude-code',
          success: false,
          filesModified,
          error: `Cannot update ${paths.mcpPath}: ${loaded.error.message}. The file was not modified.`,
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
          const backup = await backupFile(paths.mcpPath);
          if (backup) backups.push(backup);
          await atomicWrite(paths.mcpPath, text);
          filesModified.push(paths.mcpPath);
        }
      }
    }

    // Remove hook handler and clean up settings.json hooks.
    if (await removeFileIfExists(paths.hookHandler)) filesModified.push(paths.hookHandler);

    const settingsLoaded = await readConfigFile(paths.settingsPath);
    if (settingsLoaded.exists && !settingsLoaded.error) {
      const cleaned = stripWorkjournalHooks(settingsLoaded.text);
      if (cleaned !== settingsLoaded.text) {
        const backup = await backupFile(paths.settingsPath);
        if (backup) backups.push(backup);
        await atomicWrite(paths.settingsPath, cleaned);
        filesModified.push(paths.settingsPath);
      }
    }

    // Remove empty hooks dir if it only contained our handler.
    try {
      await fs.rm(paths.hooksDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }

    return { agentId: 'claude-code', success: true, filesModified, backups };
  },
};
