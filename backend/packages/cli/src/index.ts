import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { backupCommand } from './commands/backup.js';

const program = new Command();

program
  .name('workjournal')
  .description('WorkJournal CLI — local-first task continuity')
  .version('0.1.0');

program.command('start').description('Start the core service').action(startCommand);
program.command('stop').description('Stop the core service').action(stopCommand);
program.command('status').description('Check core service status').action(statusCommand);
program.command('backup').description('Create a manual backup').action(backupCommand);

program.parse();
