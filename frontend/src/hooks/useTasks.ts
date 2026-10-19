import { useState, useEffect } from 'react';
import { api } from '../lib/api';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  objective: string | null;
  acceptance_criteria: string[];
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'in_progress' | 'blocked' | 'interrupted' | 'completed' | 'cancelled';
  owner: string | null;
  version: number;
  latest_checkpoint_id: string | null;
  created_at: string;
  updated_at: string;
}

export function useTasks(projectId: string, filters?: { status?: string; priority?: string }, paging?: { limit?: number; offset?: number }) {
  const limit = paging?.limit;
  const offset = paging?.offset;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.priority) params.set('priority', filters.priority);
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const qs = params.toString();

    api.get<Task[]>(`/tasks${qs ? `?${qs}` : ''}`)
      .then(setTasks)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectId, filters?.status, filters?.priority, limit, offset]);

  return { tasks, loading, error };
}

export function useTask(taskId: string) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Task>(`/tasks/${taskId}`)
      .then(setTask)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [taskId]);

  return { task, loading, error };
}
