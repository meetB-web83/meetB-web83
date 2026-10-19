import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { normalizeRootPath } from '../db/project-db.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { NotFoundError } from '@workjournal/shared';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreateProjectData {
  name: string;
  description?: string;
  root_path: string;
  idempotency?: MutationIdempotency;
}

/**
 * Registry-side project records (`registry_projects`) â€” the index of projects, never a
 * store of task data. Project-level idempotency rows live in `registry_idempotency`.
 *
 * Creation is idempotent by root path (root AGENTS.md): registering the same folder
 * twice returns the existing project instead of failing on the UNIQUE constraint.
 * Project initialization (creating `<root>/.workjournal` + DB) is performed by the route
 * through `ProjectDbResolver.forProject`.
 */
export class ProjectService {
  private idem: IdempotencyService;

  constructor(private db: Database) {
    this.idem = new IdempotencyService(db);
  }

  async createProject(data: CreateProjectData) {
    const actor = 'operator';
    return this.idem.run(
      'registry_idempotency',
      data.idempotency && { ...data.idempotency, operation: 'project.create', actor },
      () => {
        // Root-path idempotency: match both the raw and the normalised form so a folder
        // registered as `/c/...` and later re-entered as `C:/...` stays one project.
        const normalized = normalizeRootPath(data.root_path);
        const existing = this.db.raw
          .prepare('SELECT * FROM registry_projects WHERE root_path = ? OR root_path = ?')
          .get(data.root_path, normalized) as any;
        if (existing) return existing;

        const id = uuid();
        const now = new Date().toISOString();
        this.db.raw
          .prepare(
            `INSERT INTO registry_projects (id, name, description, root_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, data.name, data.description ?? null, normalized, now, now);
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
