import { loadConfig } from '@workjournal/core';
import { readPidFile } from '../utils/pid-file.js';
import { workjournalHome } from '../utils/home.js';

/**
 * `workjournal status` — reachability AND the current PID (monitoring aid).
 *
 * The PID comes from `<home>/service.pid` and is cross-checked with
 * `process.kill(pid, 0)` so the two mismatch cases are called out instead of
 * being silently reported as "running": a stale PID file (service gone or
 * started elsewhere) and a running service with no PID file at all (foreign
 * or Docker core). The HTTP probe stays the source of truth for liveness —
 * the PID detail only decorates whichever branch it falls in.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = nothing has that pid; EPERM = it exists but is not ours → alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The PID from service.pid, validated (the file may hold junk or vanish mid-read). */
function localPid(home: string): number | null {
  try {
    const pid = readPidFile(home);
    return pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const url = `http://${config.host}:${config.port}`;
  const home = workjournalHome();
  const pid = localPid(home);
  const alive = pid !== null && pidAlive(pid);

  try {
    const response = await fetch(`${url}/api/projects`);
    if (response.ok) {
      const detail =
        pid === null
          ? ` (no service.pid in ${home} — pid unknown)`
          : alive
            ? ` (pid ${pid})`
            : ` (stale service.pid: pid ${pid} is not running)`;
      console.log(`WorkJournal core service is running at ${url}${detail}`);
    } else {
      console.log('Service responded with an error.');
    }
  } catch {
    console.log('WorkJournal core service is not running.');
    if (pid !== null) {
      console.log(
        alive
          ? `service.pid names pid ${pid}, which is alive but does not answer at ${url} — ` +
              'still starting up, or the PID belongs to another process.'
          : `service.pid is stale: pid ${pid} no longer exists.`,
      );
    }
    console.log('Start it with: pnpm start');
  }
}
