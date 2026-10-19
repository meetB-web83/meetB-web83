import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Task } from './useTasks';
import { ScopeProject } from '../components/projects/ProjectSelect';

export interface DashboardStats {
  projects: number;
  active_tasks: number;
  completed: number;
  blocked: number;
}

interface DashboardResponse {
  stats: DashboardStats;
  recent_tasks: Task[];
  projects: ScopeProject[];
}

/** One call for the home page: stats + recent tasks + the project scope list. */
export function useDashboard(rawScope: string | null, recentLimit = 6) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // If `?scope=` names a project we don't know about, fall back to All
  // rather than sending a bogus `project_id` to the API. While the project
  // list hasn't loaded yet (data === null) keep the raw value so we don't
  // flash "All projects" on first paint.
  const projectId =
    data && rawScope && !data.projects.some((p) => p.id === rawScope) ? null : rawScope;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ recent_limit: String(recentLimit) });
    if (projectId) params.set('project_id', projectId);

    api.get<DashboardResponse>(`/dashboard?${params}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectId, recentLimit]);

  return {
    stats: data?.stats ?? null,
    recentTasks: data?.recent_tasks ?? [],
    projects: data?.projects ?? [],
    loading,
    error,
  };
}
