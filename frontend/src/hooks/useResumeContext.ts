import { useState, useEffect } from 'react';
import { api } from '../lib/api';

export function useResumeContext(taskId: string) {
  const [context, setContext] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ context: string }>(`/resume?task_id=${taskId}`)
      .then((data) => setContext(data.context))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [taskId]);

  return { context, loading, error };
}
