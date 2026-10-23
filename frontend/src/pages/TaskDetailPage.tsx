import { useParams, Link } from 'react-router-dom';
import { useTask } from '../hooks/useTasks';
import { Card } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/StatusBadge';
import { PriorityBadge } from '../components/ui/PriorityBadge';
import { Spinner } from '../components/ui/Spinner';
import { TaskActions } from '../components/tasks/TaskActions';
import { Button } from '../components/ui/Button';
import { formatDateTime } from '../lib/format';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { task, loading, error } = useTask(taskId!);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [decisions, setDecisions] = useState<any[]>([]);

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

  if (loading) return <Spinner />;
  if (error || !task) return <div className="container"><p>Task not found.</p></div>;

  return (
    <div className="page">
      <div className="container">
        <Link to={`/projects/${task.project_id}`} className="btn btn-secondary back-btn">
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
              <span className="badge badge-default">v{task.version}</span>
            </div>
          </div>
          <div className="task-detail-body">
            <h1 className="task-detail-title">{task.title}</h1>
            {task.objective && <p className="task-detail-objective">{task.objective}</p>}
            <div className="task-detail-meta">
              {task.owner && <span>Owner: {task.owner}</span>}
              <span>Updated: {formatDateTime(task.updated_at)}</span>
            </div>
            <TaskActions taskId={task.id} status={task.status} version={task.version} onAction={loadDetails} />
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
            <h2 className="section-subtitle">Checkpoints</h2>
            {checkpoints.length === 0 ? (
              <div className="empty-box">No checkpoints recorded yet.</div>
            ) : (
              <div className="timeline">
                {checkpoints.map((cp) => (
                  <Card key={cp.id} variant="light" className="timeline-item">
                    <div className="timeline-header">
                      <span className="timeline-version">v{cp.task_version}</span>
                      <span className="timeline-date">{formatDateTime(cp.created_at)}</span>
                    </div>
                    <p className="timeline-summary">{cp.progress_summary}</p>
                    {cp.next_steps && <p className="timeline-next">Next: {cp.next_steps}</p>}
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
              <div className="timeline">
                {events
                  .slice()
                  .reverse()
                  .map((ev) => (
                    <div
                      key={ev.id}
                      className="timeline-event"
                      style={{
                        borderLeftColor: ev.source === 'core' ? 'var(--primary)' : 'var(--secondary)',
                      }}
                    >
                      <span className="timeline-event-type">{ev.event_type}</span>
                      <span className="timeline-event-actor">{ev.actor}</span>
                      <span className="timeline-event-time">{formatDateTime(ev.created_at)}</span>
                      {ev.category && (
                        <span className="timeline-event-category chip">{ev.category}</span>
                      )}
                      {ev.source && (
                        <span className="timeline-event-source badge">
                          {ev.source === 'core' ? 'Core' : ev.source}
                        </span>
                      )}
                      <details>
                        <summary>View payload</summary>
                        <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
                      </details>
                    </div>
                  ))}
              </div>
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
          <Link to={`/resume/${task.id}`}>
            <Button variant="secondary">View Resume Context</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
