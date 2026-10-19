import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function writePidFile(home: string): void {
  const pidFile = resolve(home, 'service.pid');
  writeFileSync(pidFile, process.pid.toString());
}

export function readPidFile(home: string): number | null {
  const pidFile = resolve(home, 'service.pid');
  if (!existsSync(pidFile)) return null;
  return parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
}
