import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { backupCommand } from './commands/backup.js';
import { mcpCommand } from './commands/mcp.js';
import { setupCommand } from './integrations/setup.js';

/** Single source of truth for the CLI version (`--version`, SEA executable). */
export const CLI_VERSION = '0.1.0';

/**
 * Build the `workjournal` command tree.
 *
 * Shared by both entry points so they dispatch identically:
 *  - `index.ts` — the normal ESM entry (pnpm/tsx runs);
 *  - `standalone.ts` — the entry bundled into the single-file SEA executable.
 */
export function createCliProgram(): Command {
  const program = new Command();

  program
    .name('workjournal')
    .description('WorkJournal CLI — local-first task continuity')
    .version(CLI_VERSION);

  program
    .command('start')
    .description('Start the core service')
    .option('--with-ui', 'Serve the dashboard from the core service (same origin as the API)')
    .option('--ui-dir <path>', 'Serve the dashboard from a built Vite dist directory')
    .option('--open', 'Open the dashboard in the default browser (implies --with-ui)')
    .action(startCommand);
  program.command('stop').description('Stop the core service').action(stopCommand);
  program.command('status').description('Check core service status').action(statusCommand);
  program.command('backup').description('Create a manual backup').action(backupCommand);
  program
    .command('mcp')
    .description('Run the MCP adapter (stdio by default; --http for Streamable HTTP)')
    .option('--http', 'Run the Streamable HTTP transport instead of stdio')
    .option('--with-ui', 'Autostart the core service with the dashboard when it is down (stdio)')
    .option('--no-autostart', 'Never autostart the core service; fail with an actionable error instead')
    .action(mcpCommand);

  program
    .command('setup')
    .description('Configure an agent integration (OpenCode, Cline, etc.)')
    .option('--agent <id>', 'Agent to configure (opencode | cline)')
    .option('--global', 'Write to global config (default)')
    .option('--project', 'Write to cwd-local config')
    .option('--dry-run', 'Print planned changes without writing')
    .option('--yes', 'Skip prompts and apply automatically')
    .option('--force', 'Overwrite conflicting managed entries')
    .option('--uninstall', 'Uninstall the specified agent integration')
    .option('--status', 'Show discovery status for all integrations')
    .action(setupCommand);

  return program;
}
