import { ProjectDbResolver } from '../db/project-db.js';
import { buildServices } from '../http/services.js';
import { NotFoundError, TaskStatus } from '@workjournal/shared';

export interface CrossProjectTaskFilter {
  projectId?: string;
  status?: string;
  priority?: string;
  limit: number;
  offset: number;
}

const ACTIVE_STATUSES: Set<string> = new Set([
  TaskStatus.Open,
  TaskStatus.InProgress,
  TaskStatus.Blocked,
  TaskStatus.Interrupted,
]);

/**
 * Dashboard overview reads (spec: stats + recents in one call, no new tables).
 * The cross-project task collector lives here so `GET /api/tasks` (unscoped branch)
 * and `GET /api/dashboard` share one code path.
 */
export class DashboardService {
  constructor(private projectDbs: ProjectDbResolver) {}

  /** Scoped to one project DB, or merged newest-first across every available one. */
  listTasksAcrossProjects(filter: CrossProjectTaskFilter) {
    if (filter.projectId) {
      const db = this.projectDbs.forProject(filter.projectId);
      return buildServices(db).tasks.listTasks({
        projectId: filter.projectId,
        status: filter.status,
        priority: filter.priority,
        limit: filter.limit,
        offset: filter.offset,
      });
    }

    const merged: Array<Record<string, any>> = [];
    for (const row of this.projectDbs.availableProjects()) {
      let db;
      try {
        db = this.projectDbs.forProject(row.id);
      } catch {
        continue; // Folder vanished between the availability check and the open.
      }
      merged.push(
        ...buildServices(db).tasks.listTasks({
          projectId: row.id,
          status: filter.status,
          priority: filter.priority,
          limit: Math.min(filter.limit + filter.offset, 500),
          offset: 0,
        }),
      );
    }
    merged.sort(
      (a, b) =>
        String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) ||
        String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return merged.slice(filter.offset, filter.offset + filter.limit);
  }

  /**
   * One dashboard payload: stats + recent tasks + the project scope list.
   * Unscoped stats count every registered project and aggregate available DBs;
   * a project_id scope narrows stats and recents to that project (404 when the
   * project is unknown or its folder is unavailable).
   */
  getOverview(query: { projectId?: string; recentLimit: number }) {
    const registered = this.projectDbs.allProjects();
    const projects = registered.map((row) => ({
      id: row.id,
      name: row.name,
      available: this.projectDbs.isAvailable(row.root_path),
    }));

    if (query.projectId && !registered.some((row) => row.id === query.projectId)) {
      throw new NotFoundError(`Project ${query.projectId} not found`);
    }

    const counts = new Map<string, number>();
    const scopes = query.projectId
      ? [{ id: query.projectId, db: this.projectDbs.forProject(query.projectId) }]
      : this.projectDbs.availableProjects().map((row) => {
          let db;
          try {
            db = this.projectDbs.forProject(row.id);
          } catch {
            return null;
          }
          return db ? { id: row.id, db } : null;
        }).filter((s): s is { id: string; db: ReturnType<ProjectDbResolver['forProject']> } => s !== null);

    for (const scope of scopes) {
      const rows = scope.db.raw
        .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
        .all() as Array<{ status: string; n: number }>;
      for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + row.n);
    }

    let active = 0;
    for (const [status, n] of counts) {
      if (ACTIVE_STATUSES.has(status)) active += n;
    }

    return {
      stats: {
        // Project count is the registry total regardless of scope: the project
        // itself is the scope, so filtering by it must not shrink the count.
        projects: registered.length,
        active_tasks: active,
        completed: counts.get(TaskStatus.Completed) ?? 0,
        blocked: counts.get(TaskStatus.Blocked) ?? 0,
      },
      recent_tasks: this.listTasksAcrossProjects({
        projectId: query.projectId,
        limit: query.recentLimit,
        offset: 0,
      }),
      projects,
    };
  }
}
