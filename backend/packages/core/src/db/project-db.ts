import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createDatabase, type Database } from './connection.js';
import { runMigrations, type MigrationFile } from './migrate.js';
import { NotFoundError } from '@workjournal/shared';
import { normalizeProjectPath } from './paths.js';

/**
 * The registry stores project root paths the way they were typed in (for example the
 * git-style `/c/Users/...` on Windows). Normalise them before touching the filesystem so
 * `<project-root>/.workjournal` resolves to a real location.
 */
export function normalizeRootPath(rootPath: string): string {
  if (process.platform === 'win32') {
    const gitStyle = /^\/([A-Za-z])(\/.*)?$/.exec(rootPath);
    if (gitStyle) return `${gitStyle[1].toUpperCase()}:${gitStyle[2] ?? '/'}`;
  }
  return rootPath;
}

/** `<project-root>/.workjournal/workjournal.db` — the project's source of truth. */
export function projectDbPath(rootPath: string): string {
  return resolve(normalizeRootPath(rootPath), '.workjournal', 'workjournal.db');
}

/**
 * Normalise a stored root_path for deterministic comparison across path
 * forms (git-style `/c/...` vs drive-style `C:/...`, trailing slashes, etc.).
 * Both sides are run through normalizeRootPath → normalizeProjectPath.
 */
export function semanticRootPath(path: string): string {
  return normalizeProjectPath(normalizeRootPath(path));
}

/**
 * Read the `projects` table from an existing project DB file without creating
 * files, running migrations or caching the connection (root AGENTS.md: the
 * project DB is authoritative). Returns [] when the file is missing, the
 * `projects` table has no rows yet, or any read failure occurs — registration
 * should fall back to a fresh uuid in those cases.
 *
 * The caller passes the preferred root path (the newly-typed registration path) which is
 * used to favour a row whose stored root_path (normalised) matches the incoming
 * path; otherwise the first row by creation order is chosen.
 */
export function readProjectRows(dbPath: string): Array<Record<string, any>> {
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = createDatabase(dbPath);
  } catch {
    return [];
  }
  try {
    return db.raw
      .prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC')
      .all() as Array<Record<string, any>>;
  } catch {
    return []; // DB file exists but migrations never ran → no projects table
  } finally {
    try {
      db.raw.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Given the rows from readProjectRows() and a preferred root path (the
 * newly-typed registration path), return the single authoritative row or null.
 * A row whose normalised root_path matches the preferred path wins; otherwise
 * the first (oldest) row by creation order is chosen.
 */
export function pickProjectRow(
  rows: Array<Record<string, any>>,
  preferredRootPath: string
): Record<string, any> | null {
  if (!rows || rows.length === 0) return null;
  const preferred = semanticRootPath(preferredRootPath);
  const match = rows.find((r) => semanticRootPath(r.root_path) === preferred);
  if (match) return match;
  // No exact spelling match — oldest wins.
  return rows[0];
}

/**
 * Given a preferred root path (newly-typed registration folder), read the
 * authoritative project row from an existing project DB or return null if
 * there is none / the DB cannot be read.  Never creates files or runs migrations
 * (root AGENTS.md: the project DB is authoritative and lazily initialized).
 */
export function readExistingProjectRow(
  dbPath: string,
  preferredRootPath: string
): Record<string, any> | null {
  const rows = readProjectRows(dbPath);
  return pickProjectRow(rows, preferredRootPath);
}

export interface ProjectScope {
  projectId: string;
  db: Database;
}

/**
 * Opens per-project databases on demand (registry DB stays the index only).
 *
 * - `forProject` creates and migrates `<root>/.workjournal/workjournal.db`, then makes
 *   the project row authoritative in that database.
 * - `forTask` / `forCheckpoint` / `forDecision` locate the project DB that holds a record
 *   by scanning registered projects, skipping unavailable (missing) folders.
 */
export class ProjectDbResolver {
  private cache = new Map<string, Database>();

  constructor(
    private registry: Database,
    private projectMigrations: string | MigrationFile[],
  ) {}

  /** Registry row for a project, or an actionable NOT_FOUND. */
  projectRow(projectId: string): Record<string, any> {
    const row = this.registry.raw
      .prepare('SELECT * FROM registry_projects WHERE id = ?')
      .get(projectId) as any;
    if (!row) throw new NotFoundError(`Project ${projectId} not found`);
    return row;
  }

  /** True when the project folder is reachable right now. */
  isAvailable(rootPath: string): boolean {
    return existsSync(normalizeRootPath(rootPath));
  }

  forProject(projectId: string): Database {
    const row = this.projectRow(projectId);
    const dbPath = projectDbPath(row.root_path);

    if (!this.isAvailable(row.root_path)) {
      throw new NotFoundError(
        `Project "${row.name}" is unavailable: folder ${normalizeRootPath(row.root_path)} does not exist. Re-register the project from its current root path.`,
      );
    }

    const db = this.open(projectId, dbPath);
    this.syncProjectRow(db, row);
    return db;
  }

  /** Locate the project DB that contains a task. Skips unavailable projects. */
  forTask(taskId: string): ProjectScope {
    const scope = this.scan('tasks', taskId);
    if (!scope) throw new NotFoundError(`Task ${taskId} not found`);
    return scope;
  }

  forCheckpoint(checkpointId: string): ProjectScope {
    const scope = this.scan('checkpoints', checkpointId);
    if (!scope) throw new NotFoundError(`Checkpoint ${checkpointId} not found`);
    return scope;
  }

  forDecision(decisionId: string): ProjectScope {
    const scope = this.scan('decisions', decisionId);
    if (!scope) throw new NotFoundError(`Decision ${decisionId} not found`);
    return scope;
  }

  closeAll(): void {
    for (const db of this.cache.values()) db.raw.close();
    this.cache.clear();
  }

  /** Re-sync the project row into an already-open project DB (after a registry edit). */
  refreshIfOpen(projectId: string): boolean {
    const db = this.cache.get(projectId);
    if (!db) return false;
    this.syncProjectRow(db, this.projectRow(projectId));
    return true;
  }

  /** Every registered project, oldest first — the dashboard scope dropdown. */
  allProjects(): Array<Record<string, any>> {
    return this.registry.raw
      .prepare('SELECT * FROM registry_projects ORDER BY created_at ASC')
      .all() as any[];
  }

  /** Registered projects whose folder currently exists on disk. */
  availableProjects(): Array<Record<string, any>> {
    const rows = this.registry.raw
      .prepare('SELECT * FROM registry_projects ORDER BY created_at ASC')
      .all() as any[];
    return rows.filter((row) => this.isAvailable(row.root_path));
  }

  private scan(table: 'tasks' | 'checkpoints' | 'decisions', id: string): ProjectScope | null {
    const rows = this.registry.raw
      .prepare('SELECT * FROM registry_projects ORDER BY created_at ASC')
      .all() as any[];

    for (const row of rows) {
      const dbPath = projectDbPath(row.root_path);
      // No project DB yet ⇒ no records in it; never create files while scanning.
      if (!existsSync(dbPath)) continue;

      const db = this.open(row.id, dbPath);
      // Table names are fixed literals here — only id values are bound parameters.
      const statement =
        table === 'tasks'
          ? db.raw.prepare('SELECT id FROM tasks WHERE id = ?')
          : table === 'checkpoints'
            ? db.raw.prepare('SELECT id FROM checkpoints WHERE id = ?')
            : db.raw.prepare('SELECT id FROM decisions WHERE id = ?');
      const found = statement.get(id) as any;
      if (found) {
        this.syncProjectRow(db, row);
        return { projectId: row.id, db };
      }
    }
    return null;
  }

  private open(projectId: string, dbPath: string): Database {
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    const db = createDatabase(dbPath);
    runMigrations(db, this.projectMigrations);
    this.cache.set(projectId, db);
    return db;
  }

  /** The project DB copy of the project row is authoritative once open. */
  private syncProjectRow(db: Database, row: Record<string, any>): void {
    db.raw
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           root_path = excluded.root_path,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.name,
        row.description ?? null,
        row.root_path,
        row.created_at,
        row.updated_at,
      );
  }
}
