import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { backupCommand } from './commands/backup.js';
import { mcpCommand } from './commands/mcp.js';

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
    .action(mcpCommand);

  return program;
}
