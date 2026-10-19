import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, sep, join, parse } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  createProjectSchema,
  updateProjectSchema,
  listProjectsQuerySchema,
  browseDirectoriesQuerySchema,
  browseDirectoriesResponseSchema,
  CreateProjectInput,
  UpdateProjectInput,
  BrowseDirectoriesQuery,
  ValidationError,
} from '@workjournal/shared';
import { normalizeRootPath } from '../../db/project-db.js';
import { validateBody, validateQuery, operationInput } from '../hooks/validation.js';
import { buildServices } from '../services.js';

/** Cap directory listings so one huge folder can't blow the 1MB body limit. */
const BROWSE_LIMIT = 200;

/** Filesystem roots: drive letters on Windows, `/` on posix. */
function filesystemRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:${sep}`;
      if (existsSync(drive)) roots.push(drive);
    }
    return roots;
  }
  return [sep];
}

export async function registerProjectRoutes(server: FastifyInstance) {
  const registry = buildServices(server.registryDb);

  /** Registry rows annotated with folder availability (dashboard "unavailable" state). */
  const withAvailability = (row: Record<string, any>) => ({
    ...row,
    available: server.projectDbs.isAvailable(row.root_path),
  });

  server.post('/', { preHandler: [validateBody(createProjectSchema)] }, async (request, reply) => {
    const input = request.body as CreateProjectInput;
    const rootPath = normalizeRootPath(input.root_path);
    if (!existsSync(rootPath)) {
      throw new ValidationError(
        `Project folder ${rootPath} does not exist. Create or choose an existing folder before registering it.`,
      );
    }

    const project = await registry.projects.createProject({
      name: input.name,
      description: input.description,
      root_path: input.root_path,
      idempotency: { key: input.idempotency_key, input: operationInput(input) },
    });

    // Initialization is idempotent: opening creates <root>/.workjournal and its DB,
    // migrating and syncing the project row on every open.
    server.projectDbs.forProject(project.id);

    return reply.status(201).send(withAvailability(project));
  });

  server.get('/', { preHandler: [validateQuery(listProjectsQuerySchema)] }, async () => {
    return registry.projects.listProjects().map(withAvailability);
  });

  // NOTE: `/browse` must register before `/:id` — Fastify matches in
  // registration order and would otherwise treat "browse" as a project id.
  /**
   * Read-only directory browser backing the dashboard folder picker.
   * Loopback-only like every other route (no auth in Release 1 per AGENTS.md).
   * Never follows `..` outside the resolved directory, never returns file
   * contents, never logs paths (secret filtering).
   */
  server.get('/browse', { preHandler: [validateQuery(browseDirectoriesQuerySchema)] }, async (request) => {
    const query = request.query as BrowseDirectoriesQuery;
    const raw = (query.path ?? '').trim();

    // No path: filesystem roots (drives on Windows, `/` elsewhere).
    if (!raw) {
      const needle = (query.search ?? '').trim().toLowerCase();
      const entries = filesystemRoots()
        .filter((root) => !needle || root.toLowerCase().includes(needle))
        .slice(0, BROWSE_LIMIT)
        .map((root) => ({ name: root, path: root, has_workjournal: existsSync(join(root, '.workjournal')) }));
      return browseDirectoriesResponseSchema.parse({ current_path: null, parent_path: null, entries });
    }

    const dir = resolve(normalizeRootPath(raw));
    // Defense in depth: `resolve` already collapses `..`, but reject anything
    // that still escapes (e.g. symlink-style games) by requiring containment.
    const root = parse(dir).root;
    if (!dir.startsWith(root)) {
      throw new ValidationError('Browse path escapes the filesystem root.');
    }
    if (!existsSync(dir)) {
      throw new ValidationError(`Folder ${raw} does not exist.`);
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dir);
    } catch {
      throw new ValidationError(`Cannot read folder ${raw}.`);
    }
    if (!stat.isDirectory()) {
      throw new ValidationError(`Browse path ${raw} is not a folder.`);
    }

    const needle = (query.search ?? '').trim().toLowerCase();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      throw new ValidationError(`Cannot list folder ${raw}. Check permissions.`);
    }

    const entries = names
      .filter((name) => !needle || name.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, BROWSE_LIMIT)
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((name) => {
        const full = join(dir, name);
        return { name, path: full, has_workjournal: existsSync(join(full, '.workjournal')) };
      });

    const parent = dirname(dir);
    return browseDirectoriesResponseSchema.parse({
      current_path: dir,
      parent_path: parent === dir ? null : parent,
      entries,
    });
  });

  server.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return withAvailability(registry.projects.getProject(id));
  });

  server.patch('/:id', { preHandler: [validateBody(updateProjectSchema)] }, async (request) => {
    const { id } = request.params as { id: string };
    const updates = request.body as UpdateProjectInput;
    const project = await registry.projects.updateProject(
      id,
      { name: updates.name, description: updates.description },
      { key: updates.idempotency_key, input: operationInput(updates) },
    );
    server.projectDbs.refreshIfOpen(id);
    return withAvailability(project);
  });
}
