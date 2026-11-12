import { useParams, Link, useLocation } from 'react-router-dom';
import { useTask } from '../hooks/useTasks';
import { Card } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/StatusBadge';
import { PriorityBadge } from '../components/ui/PriorityBadge';
import { Spinner } from '../components/ui/Spinner';
import { TaskActions } from '../components/tasks/TaskActions';
import { RollbackDialog, type ApplyResponse } from '../components/tasks/RollbackDialog';
import { Button } from '../components/ui/Button';
import { EventHistoryDialog } from '../components/ui/EventHistoryDialog';
import { formatDateTime } from '../lib/format';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';

/** Latest `revert_applied` event flattened for the rollback banner/undo (B9). */
interface LatestRollback {
  at: string;
  reason: string;
  safetySnapshotId: string;
  targetSnapshotId: string;
}

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const location = useLocation();
  const { task, loading, error } = useTask(taskId!);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  // Rollback dialog target (spec §B9): snapshot id + label, or null when closed.
  const [rollbackDialog, setRollbackDialog] = useState<{ target: string; label: string; reason?: string } | null>(null);
  const [rollbackNotice, setRollbackNotice] = useState('');
  // Task links carry { from: location } so "Back to Tasks" restores the exact
  // list URL (filters, page, view) instead of the bare project path.
  const backState = location.state as { from?: { pathname: string; search?: string } } | null;

  const loadDetails = async () => {
    if (!taskId) return;
    try {
      const [cp, ev, dec] = await Promise.all([
        api.get<any[]>(`/checkpoints?task_id=${taskId}`),
        api.get<any[]>(`/events?task_id=${taskId}`),
        api.get<any[]>(`/decisions?task_id=${taskId}&include_superseded=true`),
      ]);
      setCheckpoints(cp);
      setEvents(ev);
      setDecisions(dec);
    } catch (err) {
      console.error('Failed to load task details:', err);
    }
  };

  useEffect(() => { loadDetails(); }, [taskId]);

  // Derived at read time from the event stream (append-only), newest first.
  const revertEvents = events.filter((e) => e.event_type === 'revert_applied');
  const lastRevert = revertEvents[revertEvents.length - 1];
  const latestRollback: LatestRollback | null = lastRevert
    ? {
        at: lastRevert.created_at,
        reason: String((lastRevert.payload as any)?.reason ?? ''),
        safetySnapshotId: String((lastRevert.payload as any)?.safety_snapshot_id ?? ''),
        targetSnapshotId: String((lastRevert.payload as any)?.target_snapshot_id ?? ''),
      }
    : null;

  /** Resolve a checkpoint to its snapshot id, then open the preview dialog. */
  const startRollbackToCheckpoint = async (cp: any) => {
    setRollbackNotice('');
    try {
      const snaps = await api.get<any[]>(`/tasks/${taskId}/snapshots?limit=200`);
      const snap = snaps.find((s) => s.checkpoint_id === cp.id);
      if (!snap) {
        setRollbackNotice(`No snapshot found for checkpoint ${cp.id} — it cannot be restored.`);
        return;
      }
      setRollbackDialog({ target: snap.id, label: `checkpoint ${cp.id}` });
    } catch (err) {
      setRollbackNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRollbackApplied = (_result: ApplyResponse) => {
    // Reload so checkpoint rolled-back flags and the undo banner reflect the
    // new state; the dialog's done view keeps showing the safety snapshot.
    loadDetails();
  };

  if (loading) return <Spinner />;
  if (error || !task) return <div className="container"><p>Task not found.</p></div>;

  return (
    <div className="page">
      <div className="container">
        <Link
          to={backState?.from ?? `/projects/${task.project_id}`}
          className="btn btn-secondary back-btn"
        >
          <span className="btn-arrow btn-arrow-left" aria-hidden="true">
            ←
          </span>
          <span className="btn-label">Tasks</span>
        </Link>
        {/* Task Header */}
        <div className="card card-light task-detail-header">
          <div className="task-detail-banner">
            <div className="task-detail-badges">
              <StatusBadge status={task.status} />
              <PriorityBadge priority={task.priority} />
            </div>
          </div>
          <div className="task-detail-body">
            <h1 className="task-detail-title">{task.title}</h1>
            {task.objective && <p className="task-detail-objective">{task.objective}</p>}
            <div className="task-detail-meta">
              {task.owner && <span>Owner: {task.owner}</span>}
              <span>Updated: {formatDateTime(task.updated_at)}</span>
            </div>
            <TaskActions taskId={task.id} status={task.status} onAction={loadDetails} />
          </div>
        </div>

        {/* Acceptance Criteria */}
        {task.acceptance_criteria.length > 0 && (
          <Card variant="light" className="mt-lg">
            <h3 className="card-title">Acceptance Criteria</h3>
            <ul className="criteria-list">
              {task.acceptance_criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </Card>
        )}

        {/* Two-column layout */}
        <div className="task-detail-grid">
          {/* Checkpoints */}
          <div className="mt-md">
            <div className="section-header-row">
              <h2 className="section-subtitle">Checkpoints</h2>
              {latestRollback && latestRollback.safetySnapshotId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRollbackDialog({
                      target: latestRollback.safetySnapshotId,
                      label: 'safety snapshot (undo)',
                      reason: `undo rollback ${latestRollback.at}`,
                    })
                  }
                >
                  Undo this rollback
                </Button>
              )}
            </div>
            {latestRollback && (
              <div className="rollback-banner">
                <strong>Working tree rolled back</strong> at {formatDateTime(latestRollback.at)}
                {latestRollback.reason ? ` — ${latestRollback.reason}` : ''}
                <div className="rollback-banner-meta">
                  Undo target: safety snapshot <span className="code-tag">{latestRollback.safetySnapshotId}</span>
                </div>
              </div>
            )}
            {rollbackNotice && <p className="rollback-error">{rollbackNotice}</p>}
            {checkpoints.length === 0 ? (
              <div className="empty-box">No checkpoints recorded yet.</div>
            ) : (
              <div className="timeline">
                {checkpoints.map((cp) => (
                  <Card key={cp.id} variant="light" className="timeline-item">
                    <div className="timeline-header">
                      <span className="timeline-date">{formatDateTime(cp.created_at)}</span>
                      {cp.rolled_back && (
                        <span
                          className="rollback-badge"
                          title={cp.rolled_back_reason ?? 'Covered by a rollback'}
                        >
                          Rolled back
                        </span>
                      )}
                    </div>
                    <p className="timeline-summary">{cp.progress_summary}</p>
                    {cp.rolled_back && cp.rolled_back_reason && (
                      <p className="rollback-note">Reason: {cp.rolled_back_reason}</p>
                    )}
                    {cp.next_steps && <p className="timeline-next">Next: {cp.next_steps}</p>}
                    <div className="timeline-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startRollbackToCheckpoint(cp)}
                      >
                        Roll back to here
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Event History */}
          <div className="mt-md">
            <h2 className="section-subtitle">Event History</h2>
            {events.length === 0 ? (
              <div className="empty-box">No events recorded yet.</div>
            ) : (
              <>
                <div className="empty-box">{events.length} event(s) recorded.</div>
                <Button variant="secondary" size="sm" onClick={() => setShowEvents(true)}>
                  View all events
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Decisions */}
        {decisions.length > 0 && (
          <div className="mt-lg">
            <h2 className="section-subtitle">Decisions</h2>
            <div className="decision-list">
              {decisions.map((d) => (
                <Card key={d.id} variant={d.status === 'active' ? 'featured' : 'light'} className="decision-item">
                  <div className="decision-header">
                    <span className={`badge ${d.status === 'active' ? 'badge-success' : 'badge-dark'}`}>
                      {d.status}
                    </span>
                    {d.superseded_by && <span className="text-muted">superseded</span>}
                  </div>
                  <p className="decision-statement">{d.statement}</p>
                  {d.rationale && <p className="decision-rationale">{d.rationale}</p>}
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Resume Context Link */}
        <div className="mt-lg">
          <Link to={`/resume/${task.id}`} state={location.state}>
            <Button variant="secondary">View Resume Context</Button>
          </Link>
        </div>

        <EventHistoryDialog
          scope={{ task_id: taskId }}
          open={showEvents}
          onClose={() => setShowEvents(false)}
          title="Task event history"
        />

        {rollbackDialog && (
          <RollbackDialog
            taskId={taskId!}
            open={!!rollbackDialog}
            target={rollbackDialog.target}
            targetLabel={rollbackDialog.label}
            initialReason={rollbackDialog.reason}
            onClose={() => setRollbackDialog(null)}
            onApplied={handleRollbackApplied}
          />
        )}
      </div>
    </div>
  );
}
