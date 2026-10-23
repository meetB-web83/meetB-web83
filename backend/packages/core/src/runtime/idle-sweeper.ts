import { join } from 'node:path';
import { readdirSync, statSync, unlinkSync } from 'node:fs';

/**
 * Last-one-out auto-stop for MCP-auto-started core services (decision D-013).
 *
 * A service spawned by the MCP adapter runs with `WORKJOURNAL_AUTOSTART=1`.
 * While it runs, every stdio adapter refreshes a heartbeat file in
 * `<home>/mcp-heartbeats/`. This sweeper polls those files and hands the
 * service its shutdown the moment none has been fresh for the idle window —
 * so a service the agent started disappears again once the last agent is
 * gone, while manually started services (`enabled: false`, the default) and
 * Docker (the flag is never set there) are never touched.
 *
 * Timing knobs exist as env vars mainly for tests (short windows):
 *   AUTO_STOP_IDLE_SECONDS  (default 300) — no-fresh-heartbeat time before stop
 *   AUTO_STOP_POLL_SECONDS  (default 60)  — sweep interval
 *   AUTO_STOP_FRESH_SECONDS (default 90)  — heartbeat mtime counts as fresh
 *   (fresh > heartbeat interval of 30s; a hard-killed adapter's file ages
 *    out of the freshness window instead of pinning the service forever.)
 */

export interface AutoStopConfig {
  /** True only when the service was started by the MCP adapter. */
  enabled: boolean;
  idleMs: number;
  pollMs: number;
  freshMs: number;
}

export function loadAutoStopConfig(env: NodeJS.ProcessEnv = process.env): AutoStopConfig {
  return {
    enabled: env.WORKJOURNAL_AUTOSTART === '1',
    idleMs: secondsToMs(env.AUTO_STOP_IDLE_SECONDS, 300, 'AUTO_STOP_IDLE_SECONDS'),
    pollMs: secondsToMs(env.AUTO_STOP_POLL_SECONDS, 60, 'AUTO_STOP_POLL_SECONDS'),
    freshMs: secondsToMs(env.AUTO_STOP_FRESH_SECONDS, 90, 'AUTO_STOP_FRESH_SECONDS'),
  };
}

function secondsToMs(raw: string | undefined, fallbackSeconds: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallbackSeconds * 1_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of seconds (got "${raw}").`);
  }
  return Math.round(value * 1_000);
}

export interface IdleSweeperOptions {
  homeDir: string;
  config: AutoStopConfig;
  /** Called at most once: close the service down (stop() has already run). */
  onIdle: () => void | Promise<void>;
}

export interface IdleSweeper {
  /** Stop watching (graceful shutdown paths other than onIdle). */
  stop(): void;
}

/**
 * Start watching `<home>/mcp-heartbeats`. Returns a no-op handle when the
 * service was not auto-started, so callers need no branching. The interval
 * is unref'd: the sweeper must never be the reason a process stays alive.
 */
export function startIdleSweeper(options: IdleSweeperOptions): IdleSweeper {
  const { config } = options;
  if (!config.enabled) return { stop: () => {} };

  const dir = join(options.homeDir, 'mcp-heartbeats');
  /** Heartbeat files far older than any live adapter can produce → garbage. */
  const staleMs = Math.max(config.freshMs * 10, 60_000);
  let lastFreshAt = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();

    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = []; // No heartbeat dir yet → no clients seen.
    }

    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(dir, name);
      try {
        const age = now - statSync(file).mtimeMs;
        if (age <= config.freshMs) {
          lastFreshAt = now; // A client is alive; reset the idle clock.
          break;
        }
        if (age > staleMs) unlinkSync(file); // GC files from long-dead adapters.
      } catch {
        // Raced with an adapter unlinking its own file — ignore.
      }
    }

    if (now - lastFreshAt >= config.idleMs) {
      clearInterval(timer);
      void Promise.resolve(options.onIdle()).catch((err: unknown) => {
        process.stderr.write(`[workjournal] auto-stop failed: ${String(err)}\n`);
      });
    }
  }, config.pollMs);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
