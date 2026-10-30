import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { workjournalHome } from '../utils/home.js';
import { createLogger } from '@workjournal/shared';

const stopLogger = createLogger({ component: 'cli', command: 'stop' });

export async function stopCommand() {
  const homeDir = workjournalHome();
  const pidFile = resolve(homeDir, 'service.pid');

  stopLogger.info({ homeDir, pidFile }, 'stop command invoked');

  if (!existsSync(pidFile)) {
    stopLogger.warn({ homeDir }, 'no PID file found — service may not be running');
    console.log('No PID file found. Service may not be running.');
    return;
  }

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);

  stopLogger.info({ pid, pidFile }, 'attempting to stop service');

  try {
    process.kill(pid, 'SIGTERM');
    unlinkSync(pidFile);
    stopLogger.info({ pid }, 'service stopped successfully');
    console.log(`Stopped WorkJournal service (PID ${pid})`);
  } catch (err) {
    stopLogger.error({ pid, error: String(err) }, 'failed to stop service');
    console.error(`Failed to stop service: ${err}`);
  }
}
