import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '@workjournal/core';
import {
  createDatabase,
  runMigrations,
  buildServer,
  registryMigrationsSource,
  loadAutoStopConfig,
  startIdleSweeper,
} from '@workjournal/core';
import {
  embeddedUiAssets,
  loadUiAssetsFromDir,
  type UiAssets,
} from '@workjournal/core';
import { createLogger, getPinoConfig } from '@workjournal/shared';
import { removePidFile, writePidFile } from '../utils/pid-file.js';
import { workjournalHome } from '../utils/home.js';

const startLogger = createLogger({ component: 'cli', command: 'start' });

export interface StartOptions {
  /** Serve the dashboard from embedded assets on the same origin as the API. */
  withUi?: boolean;
  /** Serve the dashboard from this directory instead (a built Vite dist). */
  uiDir?: string;
  /** Open the dashboard in the default browser once listening (implies --with-ui). */
  open?: boolean;
}

/** Best-effort default-browser launch; failures are logged, never fatal. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* non-fatal */
  }
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  startLogger.info({ withUi: !!options.withUi, uiDir: options.uiDir || null }, 'start command invoked');
  const config = loadConfig();
  const homeDir = workjournalHome();

  startLogger.info({ homeDir, host: config.host, port: config.port }, 'opening registry database');
  const dbPath = resolve(homeDir, 'registry.db');
  const db = createDatabase(dbPath);

  startLogger.info({ dbPath }, 'running registry migrations');
  runMigrations(db, registryMigrationsSource());

  let ui: UiAssets | null = null;
  if (options.uiDir) {
    ui = loadUiAssetsFromDir(resolve(options.uiDir));
  } else if (options.withUi || options.open) {
    ui = embeddedUiAssets();
    if (!ui) {
      startLogger.error({ uiDir: options.uiDir, withUi: options.withUi, open: options.open }, 'no embedded dashboard assets available');
      console.error(
        'No embedded dashboard assets. Build the frontend (pnpm build in frontend/), then ' +
          'rebuild the backend (pnpm build in backend/), or pass --ui-dir <path-to-dist>.',
      );
      process.exit(1);
    }
  }

  const server = buildServer(db, config, { ui, logger: getPinoConfig() });

  try {
    await server.listen({ host: config.host, port: config.port });
    startLogger.info({ host: config.host, port: config.port, url: `http://${config.host}:${config.port}` }, 'core service listening');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      startLogger.warn({ port: config.port }, 'port already in use — another core is probably running');
      console.error(
        `Port ${config.port} is already in use — another WorkJournal core is probably ` +
          'running. Check "workjournal status", or stop it with "workjournal stop".',
      );
      process.exit(1);
    }
    startLogger.error({ error: String(err) }, 'failed to start core service');
    throw err;
  }

  writePidFile(homeDir);
  startLogger.info({ pid: process.pid, homeDir }, 'PID file written');
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  console.log(`WorkJournal core service running at ${url}`);
  if (ui) {
    console.log(`Dashboard: ${url}/`);
    if (options.open) openBrowser(`${url}/`);
  }

  // Last-one-out auto-stop, active ONLY when the MCP adapter spawned us
  // (WORKJOURNAL_AUTOSTART=1, decision D-013). Manual starts and Docker
  // never set the flag, so their lifecycle is unchanged.
  const autoStop = loadAutoStopConfig();
  startIdleSweeper({
    homeDir,
    config: autoStop,
    onIdle: async () => {
      startLogger.info({ idleMs: autoStop.idleMs }, 'no MCP clients — auto-stopping core');
      console.log(
        `WorkJournal: no MCP clients for ${Math.round(autoStop.idleMs / 1000)}s — ` +
          'auto-stopping (this service was started by the MCP adapter; ' +
          'run "workjournal start --with-ui" for a permanent one).',
      );
      try {
        await server.close();
      } catch {
        // Best effort — we are exiting either way.
      }
      removePidFile(homeDir);
      process.exit(0);
    },
  });

  process.on('SIGINT', async () => {
    startLogger.info('Received SIGINT — shutting down');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    startLogger.info('Received SIGTERM — shutting down');
    await server.close();
    process.exit(0);
  });
}
