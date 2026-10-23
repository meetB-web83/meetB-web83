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
import { removePidFile, writePidFile } from '../utils/pid-file.js';
import { workjournalHome } from '../utils/home.js';

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
  const config = loadConfig();
  const homeDir = workjournalHome();

  const dbPath = resolve(homeDir, 'registry.db');
  const db = createDatabase(dbPath);

  runMigrations(db, registryMigrationsSource());

  let ui: UiAssets | null = null;
  if (options.uiDir) {
    ui = loadUiAssetsFromDir(resolve(options.uiDir));
  } else if (options.withUi || options.open) {
    ui = embeddedUiAssets();
    if (!ui) {
      console.error(
        'No embedded dashboard assets. Build the frontend (pnpm build in frontend/), then ' +
          'rebuild the backend (pnpm build in backend/), or pass --ui-dir <path-to-dist>.',
      );
      process.exit(1);
    }
  }

  const server = buildServer(db, config, { ui });

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      // Two adapters can race to autostart; the loser must not clobber the
      // winner's PID file (writePidFile runs only after a successful listen).
      console.error(
        `Port ${config.port} is already in use — another WorkJournal core is probably ` +
          'running. Check "workjournal status", or stop it with "workjournal stop".',
      );
      process.exit(1);
    }
    throw err;
  }

  writePidFile(homeDir);
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

  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
}
