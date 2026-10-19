import { z } from 'zod';

/**
 * Dashboard overview query. `project_id` is optional: omitted means global scope
 * (every available project), present scopes stats and recent tasks to that project.
 * `recent_limit` caps the recent-tasks section (dashboard-sized, not a full listing —
 * use list_tasks with limit/offset for paging).
 */
export const dashboardQuerySchema = z.object({
  project_id: z.string().min(1).optional(),
  recent_limit: z.coerce.number().int().min(1).max(25).default(6),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
