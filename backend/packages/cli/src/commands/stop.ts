import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export async function stopCommand() {
  const pidFile = resolve(process.env.WORKJOURNAL_HOME || '~/.workjournal', 'service.pid');

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
