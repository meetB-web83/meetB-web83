import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
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

/** Remove the PID file if present (explicit stop and last-one-out auto-stop). */
export function removePidFile(home: string): void {
  try {
    unlinkSync(resolve(home, 'service.pid'));
  } catch {
    // Already gone — nothing to do.
  }
}
