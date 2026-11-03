/**
 * Cursor MCP settings merge (plan §10.3–§10.4, D-021).
 *
 * Cursor stores stdio servers as `mcpServers.<name>` with `type: "stdio"`,
 * `command`, and `args`. Cursor has no lifecycle plugin API, so setup installs
 * only the MCP server entry — no plugin artifacts.
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
} from '../../safe-config.js';
import { isWorkjournalCommand, workjournalMcpCommand } from '../../command.js';
import { resolveCursorPaths } from './discovery.js';

export function desiredCursorMcpEntry(): Record<string, unknown> {
  const command = workjournalMcpCommand();
  return {
    type: 'stdio',
    command: command[0],
    args: command.slice(1),
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

export async function planCursor(ctx: SetupContext): Promise<ConfigPlan> {
  const paths = resolveCursorPaths(ctx);
  const basePlan = { agentId: 'cursor', scope: ctx.scope };
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
        type: 'stdio',
        command: workjournalMcpCommand()[0],
        args: workjournalMcpCommand().slice(1),
      }
    : desiredCursorMcpEntry();

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

  return { ...basePlan, files, managedEntries, warnings };
}
