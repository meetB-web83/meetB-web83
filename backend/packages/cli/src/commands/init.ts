import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '@workjournal/core';
import { createLogger } from '@workjournal/shared';

/** Shape written to `<root>/.workjournal/project.json` so the MCP adapter can
 *  discover the project id by walking up from cwd (like Git finds .git). */
interface ProjectMarker {
  projectId: string;
  projectName: string;
  rootPath: string;
  updatedAt: string;
}

const MARKER_FILE = 'project.json';

/** Deterministic idempotency key for re-init of the same folder (fits the
 *  idempotency key pattern `^[A-Za-z0-9_-]{1,128}$`). */
function initIdempotencyKey(rootPath: string): string {
  const hash = createHash('sha256').update(rootPath).digest('hex').slice(0, 24);
  return `init-${hash}`;
}

/** Core base URL from the shared config. */
function coreBaseUrl(): string {
  const config = loadConfig();
  return `http://${config.host}:${config.port}`;
}

/** Register (or re-register) the project at `root` with Core over HTTP, then
 *  write the marker file so MCP agents can discover the project id from cwd. */
export async function initCommand(options: { name?: string; root?: string } = {}): Promise<void> {
  const initLogger = createLogger({ component: 'cli', command: 'init' });
  const root = resolve(options.root || process.cwd());
  const name = options.name || root.split(/[\\/]/).pop() || root;

  initLogger.info({ root, name }, 'init command invoked');

  if (!existsSync(root)) {
    throw new Error(`Project folder ${root} does not exist.`);
  }

  const config = loadConfig();
  const idempotencyKey = initIdempotencyKey(root);

  // Register / adopt the project through Core (only Core owns the registry DB).
  let project: { id: string; name: string; root_path: string };
  try {
    const res = await fetch(`${coreBaseUrl()}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        root_path: root,
        idempotency_key: idempotencyKey,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Core rejected project registration (${res.status}): ${body}`);
    }
    project = (await res.json()) as { id: string; name: string; root_path: string };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Core rejected')) throw err;
    throw new Error(
      `Could not reach the WorkJournal core service at ${coreBaseUrl()}. ` +
        'Start it with "workjournal start --with-ui" and retry.',
    );
  }

  // Write the marker file so the MCP adapter can walk up from cwd and discover
  // this project id without path matching (Git-Bash /c, WSL /mnt/c, Windows
  // case-folding all safe).
  const workjournalDir = resolve(root, '.workjournal');
  mkdirSync(workjournalDir, { recursive: true });
  const marker: ProjectMarker = {
    projectId: project.id,
    projectName: project.name,
    rootPath: root,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(workjournalDir, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n');

  initLogger.info(
    { root, projectId: project.id, marker: resolve(workjournalDir, MARKER_FILE) },
    'init complete — marker written',
  );

  console.log(
    `WorkJournal project initialized\n` +
      `  id:      ${project.id}\n` +
      `  name:    ${project.name}\n` +
      `  root:    ${root}\n` +
      `  marker:  ${resolve(workjournalDir, MARKER_FILE)}\n` +
      `\nPass the project id to MCP tools, e.g. list_tasks with project_id="${project.id}".`,
  );
}
