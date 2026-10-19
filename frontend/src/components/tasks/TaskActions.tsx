import { useState } from 'react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { toast } from 'react-toastify';

interface TaskActionsProps {
  taskId: string;
  status: string;
  version: number;
  onAction: () => void;
}

export function TaskActions({ taskId, status, version, onAction }: TaskActionsProps) {
  const [loading, setLoading] = useState(false);

  // Terminal states have no actions — render nothing instead of an empty bordered dock.
  if (status === 'completed' || status === 'cancelled') return null;

  const handleAction = async (action: string, body: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      await api.post(`/tasks/${taskId}/${action}`, { task_id: taskId, expected_version: version, idempotency_key: crypto.randomUUID(), ...body });
      onAction();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="task-actions">
      {status === 'open' && (
        <Button variant="primary" size="sm" disabled={loading} onClick={() => handleAction('claim', { agent_id: 'operator' })}>
          Claim
        </Button>
      )}
      {status === 'in_progress' && (
        <>
          <Button variant="primary" size="sm" disabled={loading} onClick={() => handleAction('transition', { agent_id: 'operator', target_status: 'completed' })}>
            Complete
          </Button>
          <Button variant="secondary" size="sm" disabled={loading} onClick={() => handleAction('transition', { agent_id: 'operator', target_status: 'blocked', reason: 'Blocked' })}>
            Block
          </Button>
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => handleAction('release', { agent_id: 'operator' })}>
            Release
          </Button>
        </>
      )}
      {status === 'blocked' && (
        <Button variant="primary" size="sm" disabled={loading} onClick={() => handleAction('transition', { agent_id: 'operator', target_status: 'open', resolution_note: 'Unblocked' })}>
          Unblock
        </Button>
      )}
      {status === 'interrupted' && (
        <Button variant="primary" size="sm" disabled={loading} onClick={() => handleAction('claim', { agent_id: 'operator' })}>
          Resume
        </Button>
      )}
    </div>
  );
}
