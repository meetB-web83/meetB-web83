import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { normalizeRootPath, semanticRootPath, projectDbPath, readExistingProjectRow } from '../db/project-db.js';
import { toContainerPath, normalizeProjectPath, fromContainerPath, type PathContext } from '../db/paths.js';
import { existsSync } from 'node:fs';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { NotFoundError, ValidationError } from '@workjournal/shared';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreateProjectData {
  name: string;
  description?: string;
  root_path: string;
  idempotency?: MutationIdempotency;
}

/**
 * Registry-side project records (`registry_projects`) – the index of projects, never a
 * store of task data. Project-level idempotency rows live in `registry_idempotency`.
 *
 * Creation is idempotent by root path (root AGENTS.md): registering the same folder
 * twice returns the existing project instead of failing on the UNIQUE constraint.
 * Project initialization (creating `<root>/.workjournal` + DB) is performed by the route
 * through `ProjectDbResolver.forProject`.
 *
 * Project identity is authoritative from the project DB (root AGENTS.md). When a folder
 * is re-registered after the registry was lost (or a folder was moved), the project DB's
 * stored project ID is adopted so that tasks, events, checkpoints and decisions remain
 * associated with the correct project.  A copied .workjournal that belongs to a live
 * registration elsewhere is rejected with an actionable error.
 */
export class ProjectService {
  private idem: IdempotencyService;
  private pathContext: PathContext | null;

  constructor(private db: Database, pathContext: PathContext | null = null) {
    this.idem = new IdempotencyService(db);
    this.pathContext = pathContext;
  }

  async createProject(data: CreateProjectData) {
    const actor = 'operator';
    return this.idem.run(
      'registry_idempotency',
      data.idempotency && { ...data.idempotency, operation: 'project.create', actor },
      () => {
        // Root-path idempotency: match the raw, the normalised and the
        // container-mapped form so a folder registered as `C:/...`, `/c/...`
        // or `/host-projects/...` stays one project (Docker mapping included).
        const normalized = normalizeRootPath(data.root_path);
        const containerPath = normalizeProjectPath(toContainerPath(this.pathContext, data.root_path));
        const existing = this.db.raw
          .prepare('SELECT * FROM registry_projects WHERE root_path = ? OR root_path = ? OR root_path = ?')
          .get(data.root_path, normalized, containerPath) as any;
        if (existing) return existing;

        // The project DB is authoritative (root AGENTS.md): when the folder was
        // previously registered (registry lost, folder moved), adopt its ID instead
        // of minting a fresh one.  If the DB has no project row yet, fall back to a new UUID.
        const dbPath = projectDbPath(containerPath);
        const adopted = readExistingProjectRow(dbPath, containerPath);
        let id: string;
        if (!adopted) {
          // No existing project DB – mint a fresh UUID and insert a new registry row.
          id = uuid();
          const now = new Date().toISOString();
          this.db.raw
            .prepare(
              `INSERT INTO registry_projects (id, name, description, root_path, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(id, data.name, data.description ?? null, containerPath, now, now);
        } else {
          // The adopted ID already exists in the registry from a different path.
          const byId = this.db.raw
            .prepare('SELECT * FROM registry_projects WHERE id = ?')
            .get(adopted.id) as any;
          if (!byId) {
            // Registry has no row for this id – the registry was rebuilt (root AGENTS.md:
            // the registry is a rebuildable index).  Insert a new row with the adopted id.
            const now = new Date().toISOString();
            this.db.raw
              .prepare(
                `INSERT INTO registry_projects (id, name, description, root_path, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(adopted.id, data.name, data.description ?? null, containerPath, now, now);
            id = adopted.id;
          } else if (semanticRootPath(byId.root_path) === semanticRootPath(containerPath)) {
            // Same project, different path spelling (git vs drive) – return existing.
            return this.getProject(byId.id);
          } else if (!existsSync(normalizeRootPath(byId.root_path))) {
            // Moved folder: the old registry path is gone; the project follows the folder.
            const now = new Date().toISOString();
            this.db.raw
              .prepare(
                `UPDATE registry_projects SET root_path = ?, updated_at = ? WHERE id = ?`,
              )
              .run(containerPath, now, byId.id);
            id = byId.id;
          } else {
            // Copied folder: the id belongs to a live registration at another path.
            throw new ValidationError(
              `The .workjournal database at ${normalizeRootPath(
                byId.root_path,
              )} already belongs to registered project "${byId.name}" at that path. ` +
              `Register that project's current folder instead, or delete the copied ` +
              `.workjournal folder to start a fresh project.`,
            );
          }
        }
        return this.getProject(id);
      },
    );
  }

  getProject(projectId: string) {
    const row = this.db.raw.prepare('SELECT * FROM registry_projects WHERE id = ?').get(projectId) as any;
    if (!row) throw new NotFoundError(`Project ${projectId} not found`);
    return row;
  }

  listProjects() {
    return this.db.raw
      .prepare('SELECT * FROM registry_projects ORDER BY created_at DESC, id ASC')
      .all();
  }

  async updateProject(
    projectId: string,
    updates: { name?: string; description?: string },
    idempotency?: MutationIdempotency,
  ) {
    return this.idem.run(
      'registry_idempotency',
      idempotency && { ...idempotency, operation: 'project.update', actor: 'operator' },
      () => {
        const project = this.getProject(projectId);
        const now = new Date().toISOString();
        this.db.raw
          .prepare('UPDATE registry_projects SET name = ?, description = ?, updated_at = ? WHERE id = ?')
          .run(
            updates.name ?? project.name,
            updates.description ?? project.description ?? null,
            now,
            projectId,
          );
        return this.getProject(projectId);
      },
    );
  }

  deleteProject(projectId: string) {
    this.db.raw.prepare('DELETE FROM registry_projects WHERE id = ?').run(projectId);
  }
}