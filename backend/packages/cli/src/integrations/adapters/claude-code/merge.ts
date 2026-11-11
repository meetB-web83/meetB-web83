/**
 * Claude Code MCP + hooks merge (plan §10.3–§10.4, D-021).
 *
 * Claude Code stores stdio servers as `mcpServers.<name>` with a `command`
 * string and `args` array under `mcpServers` in `~/.claude.json` (user scope)
 * or `.mcp.json` (project scope). Hooks are configured in `.claude/settings.json`
 * under the `hooks` key and point command-type hooks at an ingest handler
 * script that POSTs canonical ledger envelopes to Core.
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
import { resolveClaudeCodePaths } from './discovery.js';
import { claudeCodeHookHandlerSource, claudeCodePluginVersion } from './plugin.generated.js';

export function desiredClaudeCodeMcpEntry(): Record<string, unknown> {
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

/** Build the Claude Code hooks configuration JSON text. */
function buildHooksConfig(existing: unknown, hookHandlerPath: string): string {
  const hookEntry = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `node "${hookHandlerPath}" SessionStart`,
      },
      {
        type: 'command',
        command: `node "${hookHandlerPath}" SessionEnd`,
      },
      {
        type: 'command',
        command: `node "${hookHandlerPath}" PreToolUse`,
      },
      {
        type: 'command',
        command: `node "${hookHandlerPath}" PostToolUse`,
      },
      {
        type: 'command',
        command: `node "${hookHandlerPath}" Stop`,
      },
      {
        type: 'command',
        command: `node "${hookHandlerPath}" Notification`,
      },
    ],
  };

  let hooks: unknown[];
  if (isPlainObject(existing)) {
    const existingHooks = (existing as any).hooks;
    if (Array.isArray(existingHooks)) {
      hooks = existingHooks.filter((h: unknown) => {
        if (!isPlainObject(h)) return true;
        const cmds = (h as any).hooks;
        if (!Array.isArray(cmds)) return true;
        return !cmds.some((c: unknown) => isPlainObject(c) && typeof (c as any).command === 'string' && ((c as any).command as string).includes('workjournal-ingest.js'));
      });
      hooks.push(hookEntry);
    } else {
      hooks = [hookEntry];
    }
  } else {
    hooks = [hookEntry];
  }

  return JSON.stringify({ hooks }, null, 2) + '\n';
}

export async function planClaudeCode(ctx: SetupContext): Promise<ConfigPlan> {
  const paths = resolveClaudeCodePaths(ctx);
  const basePlan = { agentId: 'claude-code', scope: ctx.scope };
  const loaded = await readConfigFile(paths.mcpPath);
  const managedEntries: ConfigPlan['managedEntries'] = [];

  if (loaded.error) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.mcpPath}: the file is not valid JSON (${loaded.error.message}). The file was not modified.`,
    };
  }
  if (loaded.exists && !isPlainObject(loaded.data)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.mcpPath}: the top-level JSON value must be an object.`,
    };
  }

  const servers = getAtPath(loaded.data, ['mcpServers']);
  if (servers !== undefined && !isPlainObject(servers)) {
    return {
      ...basePlan,
      files: [],
      managedEntries,
      error: `Cannot update ${paths.mcpPath}: "mcpServers" must be an object.`,
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
    : desiredClaudeCodeMcpEntry();

  const mcpText = setJsoncValue(loaded.exists ? loaded.text : '{\n}\n', ['mcpServers', 'workjournal'], desired);
  const mcpUnchanged = loaded.exists && mcpText === loaded.text;

  const warnings: string[] = [];
  const files: PlannedFile[] = [
    mcpUnchanged
      ? { path: paths.mcpPath, action: 'noop' }
      : {
          path: paths.mcpPath,
          action: loaded.exists ? 'update' : 'create',
          content: mcpText,
        },
  ];

  managedEntries.push({
    file: paths.mcpPath,
    key: 'mcpServers.workjournal',
    value: JSON.stringify(desired),
  });

  // Hook handler script + settings — installed globally only, since Claude Code
  // session lifecycle is user-scoped and a project copy would double-report.
  const hookHandlerContent = ensureTrailingNewline(claudeCodeHookHandlerSource.trim());
  const hookHash = sha256Hex(hookHandlerContent);

  files.push(
    await plannedFile(paths.hookHandler, hookHandlerContent),
  );
  managedEntries.push({
    file: paths.hookHandler,
    key: 'hookHandler',
    value: paths.hookHandler,
  });

  // Update .claude/settings.json to register the hooks.
  const settingsLoaded = await readConfigFile(paths.settingsPath);
  if (settingsLoaded.error) {
    warnings.push(
      `Cannot configure hooks in ${paths.settingsPath}: not valid JSON (${settingsLoaded.error.message}). ` +
        'MCP server is configured but lifecycle hooks are not.',
    );
  } else {
    const hooksText = buildHooksConfig(settingsLoaded.data, paths.hookHandler);
    const settingsUnchanged = settingsLoaded.exists && hooksText === settingsLoaded.text;
    files.push(
      settingsUnchanged
        ? { path: paths.settingsPath, action: 'noop' }
        : {
            path: paths.settingsPath,
            action: settingsLoaded.exists ? 'update' : 'create',
            content: hooksText,
          },
    );
    managedEntries.push({
      file: paths.settingsPath,
      key: 'hooks',
      value: JSON.stringify({ hooks: 'configured for workjournal' }),
    });
  }

  return { ...basePlan, files, managedEntries, warnings };
}
