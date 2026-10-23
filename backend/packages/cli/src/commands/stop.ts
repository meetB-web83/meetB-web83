import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { workjournalHome } from '../utils/home.js';

export async function stopCommand() {
  const pidFile = resolve(workjournalHome(), 'service.pid');

  if (!existsSync(pidFile)) {
    console.log('No PID file found. Service may not be running.');
    return;
  }

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    unlinkSync(pidFile);
    console.log(`Stopped WorkJournal service (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop service: ${err}`);
  }
}
