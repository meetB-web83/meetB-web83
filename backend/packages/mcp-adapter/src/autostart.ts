import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { AdapterConfig } from './config.js';
import { startStdioServer } from './stdio.js';

/**
 * Self-starting stdio adapter (decision D-013).
 *
 * Before serving MCP, `ensureCore` probes the core service and — when it is
 * unreachable — starts it as a DETACHED process of the same executable
 * (`workjournal start [--with-ui]` with `WORKJOURNAL_AUTOSTART=1`), so the
 * service outlives this adapter: agent sessions come and go, the journal
 * keeps running. The auto-started core stops itself last-one-out once no
 * adapter refreshes a heartbeat file (see core's `idle-sweeper.ts`).
 *
 * With `--with-ui`, an ALREADY-RUNNING core that lacks the dashboard is
 * stopped and replaced by one that serves it (decision D-014) — any origin
 * counts (manual starts included), unless `--no-autostart` opts out.
 *
 * Constraints (bundled into the Node SEA executable, decision D-012):
 * CommonJS only — no top-level await, no `import.meta` anywhere in this file.
 * Logs go to stderr only: stdout carries the MCP JSON-RPC stream.
 */

/** Subdirectory of the WorkJournal home holding adapter liveness files. */
export const HEARTBEAT_DIR_NAME = 'mcp-heartbeats';

/** Expand a leading `~` in WORKJOURNAL_HOME (default `~/.workjournal`). */
export function expandHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.WORKJOURNAL_HOME || '~/.workjournal';
  return raw.replace(/^~/, env.HOME || env.USERPROFILE || '.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET `url`; null on network error / timeout (never throws). */
async function probe(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

export interface SpawnTarget {
  /** Executable to run: the SEA `workjournal` itself, or the current Node. */
  command: string;
  /** Args before `start …`: `[]` for the SEA, `[<cli entry>]` under Node. */
  prefixArgs: string[];
}

/**
 * How to spawn `start` from this process:
 *  - the SEA executable (built by `pnpm build:exe`, always named
 *    `workjournal(.exe)`) re-runs ITSELF — the no-Node-install path;
 *  - a source/dev run (`tsx`/`node …/cli/dist/index.js`) needs an explicit
 *    `MCP_AUTOSTART_ENTRY` pointing at the CLI entry; without it there is no
 *    safe way to re-launch a `.ts`/`.js` entry, so autostart is unavailable
 *    and the caller falls back to the actionable error.
 */
export function resolveSpawnTarget(env: NodeJS.ProcessEnv = process.env): SpawnTarget | null {
  if (/^workjournal(\.exe)?$/i.test(basename(process.execPath))) {
    return { command: process.execPath, prefixArgs: [] };
  }
  const entry = env.MCP_AUTOSTART_ENTRY;
  if (entry && existsSync(entry)) {
    return { command: process.execPath, prefixArgs: [entry] };
  }
  return null;
}

/** Append a line to stderr (stdout is reserved for the MCP stream). */
function note(message: string): void {
  process.stderr.write(`[workjournal] ${message}\n`);
}

/**
 * When `--with-ui` was requested but the core lacks the dashboard, attach
 * as-is (no disruptive restart) and say how to get the UI. Used on every
 * path where the override could not run (decision D-014's guard rails).
 */
function noteUiMissing(): void {
  note(
    'core is running WITHOUT the dashboard — tools work either way; restart it ' +
      'with "workjournal start --with-ui" to serve the UI.',
  );
}

/** GET `${base}/`; true only when it answers with the dashboard's HTML. */
async function servesDashboard(base: string): Promise<boolean> {
  const res = await probe(`${base}/`, 2_000);
  return Boolean(res?.ok && (res.headers.get('content-type') ?? '').includes('text/html'));
}

/** The core's PID from `<home>/service.pid`; null when missing/unreadable. */
function readServicePid(homeDir: string): number | null {
  try {
    const pid = parseInt(readFileSync(join(homeDir, 'service.pid'), 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `pid: N` for the attach note — the number only when `<home>/service.pid`
 * names a LIVE process (`process.kill(pid, 0)`; EPERM = alive but not ours),
 * `unknown` otherwise, so a stale file never makes the log line lie.
 */
function describeLocalPid(env: NodeJS.ProcessEnv): string {
  const pid = readServicePid(expandHomeDir(env));
  if (pid === null) return 'unknown';
  try {
    process.kill(pid, 0);
    return String(pid);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? String(pid) : 'unknown';
  }
}

/**
 * Poll `/health` until the fetch fails — nothing is accepting on the port any
 * more, so the old core's listener is closed and the port is free for its
 * replacement (the EADDRINUSE barrier). A non-2xx answer still counts as
 * listening.
 */
async function waitUntilDown(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(healthUrl, 1_000)) === null) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Stop the core at `pid` and wait until its listener is gone (D-014).
 * SIGTERM first — on a POSIX core its handler closes the server cleanly; on
 * Windows `process.kill` terminates unconditionally either way. Escalate to
 * SIGKILL if it still answers after the grace window, then wait again.
 * Returns true once /health stops answering. ESRCH (already dead — e.g. a
 * concurrent adapter replaced it first) counts as down; anything else keeps
 * polling and surfaces as `false` so the caller attaches instead of failing.
 */
async function stopRunningCore(pid: number, healthUrl: string): Promise<boolean> {
  const send = (signal: NodeJS.Signals): void => {
    try {
      process.kill(pid, signal);
    } catch {
      // ESRCH — already gone. Anything else (EPERM, stale pid) still answers
      // /health below, which correctly ends in "could not stop it".
    }
  };
  send('SIGTERM');
  if (await waitUntilDown(healthUrl, 8_000)) return true;
  send('SIGKILL');
  return waitUntilDown(healthUrl, 5_000);
}

/**
 * `mcp --with-ui` against an ALREADY-RUNNING core (decision D-014):
 *
 *  - dashboard present → attach as-is (nothing to gain from a restart);
 *  - `--no-autostart` → attach + note: the flag keeps this adapter off the
 *    core's lifecycle entirely (it only allows start-when-down);
 *  - no spawn target / no `service.pid` → attach + note: we cannot identify
 *    the process and safely re-create it (e.g. a Docker/remote core);
 *  - otherwise STOP the running core — whatever its origin, meetb's scope is
 *    "any core without the UI", manual starts included — wait until its
 *    listener is gone, drop the now-stale PID file and spawn a `--with-ui`
 *    replacement (WORKJOURNAL_AUTOSTART=1, so last-one-out applies to it).
 *
 * Never throws on a failed replacement: a core we can attach to stays
 * attached (MCP must serve), with stderr notes explaining what happened.
 */
async function ensureDashboard(
  config: AdapterConfig,
  env: NodeJS.ProcessEnv,
  healthUrl: string,
): Promise<void> {
  if (!config.withUi) return;
  const base = config.coreUrl.replace(/\/+$/, '');
  if (await servesDashboard(base)) return;

  if (!config.autostart) {
    noteUiMissing();
    return;
  }

  const target = resolveSpawnTarget(env);
  if (!target) {
    note(
      `the running core serves no dashboard at ${base}, but it cannot be replaced in ` +
        'this runtime (only the SEA "workjournal" executable can re-spawn itself; ' +
        'source runs need MCP_AUTOSTART_ENTRY=<path-to-cli-entry>).',
    );
    noteUiMissing();
    return;
  }

  const homeDir = expandHomeDir(env);
  const pid = readServicePid(homeDir);
  if (pid === null) {
    note(`no service.pid in ${homeDir} — cannot identify the running core to stop it.`);
    noteUiMissing();
    return;
  }

  note(
    `core is running WITHOUT the dashboard — replacing it (pid ${pid}) with one ` +
      'that serves it (a brief gap for any other attached clients).',
  );

  if (!(await stopRunningCore(pid, healthUrl))) {
    // Maybe a concurrent `--with-ui` adapter already swapped in a dashboard
    // core while we were waiting — then there is nothing left to note.
    if (await servesDashboard(base)) return;
    note(`could not stop the running core (pid ${pid}) — attaching without the dashboard.`);
    noteUiMissing();
    return;
  }

  // The old core is gone; its PID file is stale — unless a racing adapter's
  // replacement already wrote a NEW pid there (never clobber that one).
  if (readServicePid(homeDir) === pid) {
    try {
      unlinkSync(join(homeDir, 'service.pid'));
    } catch {
      // Already gone — the new start rewrites it after a successful listen.
    }
  }

  await spawnCoreDetached(config, target, env, pid);
}

/**
 * Detached-spawn `start [--with-ui]` (env `WORKJOURNAL_AUTOSTART=1`, output
 * appended to `<home>/service.log`) and poll `/health` until healthy or
 * `autostartTimeoutMs` elapses (throwing with the log path then).
 * `replacedPid` set → this is D-014's replacement of a UI-less core.
 */
async function spawnCoreDetached(
  config: AdapterConfig,
  target: SpawnTarget,
  env: NodeJS.ProcessEnv,
  replacedPid?: number,
): Promise<void> {
  const base = config.coreUrl.replace(/\/+$/, '');
  const healthUrl = `${base}/health`;
  const actionable = `WorkJournal core service is not reachable at ${base}. ` +
    'Start it with "workjournal start --with-ui" and retry.';

  // Redirect the detached service's output to <home>/service.log so an
  // autostarted (window-less) process stays diagnosable.
  const homeDir = expandHomeDir(env);
  mkdirSync(homeDir, { recursive: true });
  const logPath = join(homeDir, 'service.log');
  const logFd = openSync(logPath, 'a');

  const args = [...target.prefixArgs, 'start', ...(config.withUi ? ['--with-ui'] : [])];
  let child: ChildProcess;
  let spawnError: Error | null = null;
  try {
    child = spawn(target.command, args, {
      env: { ...env, WORKJOURNAL_AUTOSTART: '1' },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
  } catch (err) {
    spawnError = err instanceof Error ? err : new Error(String(err));
    child = null as unknown as ChildProcess;
  }
  child?.on('error', (err: Error) => {
    spawnError = err;
  });
  child?.unref();

  if (replacedPid !== undefined) {
    note(
      `replacement core spawning (old pid ${replacedPid}` +
        `${child?.pid ? ` → pid ${child.pid}` : ''}), log: ${logPath}`,
    );
  } else {
    note(
      `core service is not reachable at ${base} — starting it` +
        `${config.withUi ? ' with the dashboard' : ''}` +
        `${child?.pid ? ` (pid ${child.pid})` : ''}, log: ${logPath}`,
    );
  }

  const deadline = Date.now() + config.autostartTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Could not start the WorkJournal core service: ${spawnError.message}. ${actionable}`);
    }
    const attempt = await probe(healthUrl, 2_000);
    if (attempt?.ok) return;
    await sleep(250);
  }
  throw new Error(
    `The auto-started WorkJournal core service did not become healthy within ` +
      `${config.autostartTimeoutMs}ms — check ${logPath}. ${actionable}`,
  );
}

/**
 * Make sure the core service is reachable before the MCP server starts.
 *
 *  - healthy → log `connecting to existing core … (pid: N)` on stderr
 *    (decision D-015), then `ensureDashboard` (attach as-is; with `--with-ui`,
 *    stop and replace a core that lacks the dashboard — decision D-014);
 *  - down + autostart off (`--no-autostart`) → throw the actionable error;
 *  - down + autostart on → spawn detached, poll /health until healthy
 *    (`autostartTimeoutMs`), throw with the service-log path on timeout.
 */
export async function ensureCore(config: AdapterConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const base = config.coreUrl.replace(/\/+$/, '');
  const healthUrl = `${base}/health`;
  const actionable = `WorkJournal core service is not reachable at ${base}. ` +
    'Start it with "workjournal start --with-ui" and retry.';

  const healthy = await probe(healthUrl, 2_000);
  if (healthy?.ok) {
    // Attach is silent no more: say WHICH core we joined and under which pid
    // (stderr only — stdout carries the MCP stream). decision D-015.
    note(`connecting to existing core running at ${base} (pid: ${describeLocalPid(env)})`);
    await ensureDashboard(config, env, healthUrl);
    return;
  }

  if (!config.autostart) throw new Error(actionable);

  const target = resolveSpawnTarget(env);
  if (!target) {
    note(
      `core service is down at ${base}, but autostart is unavailable in this runtime ` +
        '(only the SEA "workjournal" executable can re-spawn itself; source runs need ' +
        'MCP_AUTOSTART_ENTRY=<path-to-cli-entry>).',
    );
    throw new Error(actionable);
  }

  await spawnCoreDetached(config, target, env);
}

/**
 * Register this adapter as a live MCP client: create
 * `<home>/mcp-heartbeats/<pid>.json`, refresh it every `heartbeatSeconds`,
 * and remove it on any orderly exit (stdin close from the client, signals,
 * process exit). A hard kill leaves the file behind; its mtime then ages out
 * of the core's freshness window, so a crashed adapter still releases the
 * service. The timer is unref'd so the heartbeat itself never keeps the
 * process alive.
 */
export function startHeartbeat(
  config: Pick<AdapterConfig, 'heartbeatSeconds'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = join(expandHomeDir(env), HEARTBEAT_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.json`);

  const touch = (): void => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    } catch {
      // Home unavailable — the core's idle window still bounds the service.
    }
  };
  touch();
  const timer = setInterval(touch, config.heartbeatSeconds * 1_000);
  timer.unref();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    try {
      unlinkSync(file);
    } catch {
      // Already gone (or never written) — nothing to do.
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  // The MCP client owns our lifetime over stdio: when its end of the pipe
  // closes, unregister and exit so the last-one-out auto-stop can fire.
  const sayGoodbye = (): void => {
    cleanup();
    process.exit(0);
  };
  process.stdin.on('end', sayGoodbye);
  process.stdin.on('close', sayGoodbye);
  process.stdin.on('error', sayGoodbye);
}

/**
 * The stdio entry both `workjournal mcp` and the adapter's own `index.ts`
 * use: make sure the core is up, register the heartbeat, then serve MCP.
 */
export async function runStdioAdapter(config: AdapterConfig): Promise<void> {
  await ensureCore(config);
  startHeartbeat(config);
  await startStdioServer(config.coreUrl);
}
