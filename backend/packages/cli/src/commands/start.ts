import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '@workjournal/core';
import {
  createDatabase,
  runMigrations,
  buildServer,
  registryMigrationsSource,
} from '@workjournal/core';
import {
  embeddedUiAssets,
  loadUiAssetsFromDir,
  type UiAssets,
} from '@workjournal/core';
import { writePidFile } from '../utils/pid-file.js';

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
  const homeDir = config.workjournalHome.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');

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

  writePidFile(homeDir);

  await server.listen({ host: config.host, port: config.port });
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  console.log(`WorkJournal core service running at ${url}`);
  if (ui) {
    console.log(`Dashboard: ${url}/`);
    if (options.open) openBrowser(`${url}/`);
  }

  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
}
