/**
 * Cross-platform command lookup for agent discovery.
 *
 * npm-installed CLIs on Windows are `.cmd` shims, which `execFileSync('cline')`
 * cannot execute without a shell. Resolving the file on PATH instead of
 * spawning it makes detection work the same in Git Bash, PowerShell, and CI.
 */

import { statSync } from 'node:fs';
import { basename, delimiter, extname, join } from 'node:path';

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Resolve a command name to an executable file on PATH (or an absolute path). */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/[\\/]/.test(command)) {
    return isFile(command) ? command : undefined;
  }

  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const hasExtension = extname(command).length > 0;
  const extensions = hasExtension
    ? ['']
    : process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
      : [''];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Command OpenCode/Cline should launch for the WorkJournal MCP adapter.
 *
 * Prefers the running SEA executable, then a `workjournal` on PATH, then the
 * bare command name (the agent's own PATH may differ from this process).
 * `WORKJOURNAL_MCP_COMMAND` overrides it (JSON array or whitespace-separated).
 */
export function workjournalMcpCommand(): string[] {
  const override = process.env.WORKJOURNAL_MCP_COMMAND?.trim();
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) {
        return parsed;
      }
    } catch {
      /* fall through to whitespace splitting */
    }
    return override.split(/\s+/);
  }

  const running = basename(process.execPath).toLowerCase().replace(/\.exe$/, '');
  if (running === 'workjournal') {
    return [process.execPath, 'mcp', '--with-ui'];
  }

  const resolved = resolveCommandPath('workjournal');
  if (resolved) {
    return [resolved, 'mcp', '--with-ui'];
  }
  return ['workjournal', 'mcp', '--with-ui'];
}

/** True when an MCP entry's command targets the WorkJournal executable. */
export function isWorkjournalCommand(command: unknown): boolean {
  const text = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string').join(' ')
    : typeof command === 'string'
      ? command
      : '';
  return text.toLowerCase().includes('workjournal');
}
