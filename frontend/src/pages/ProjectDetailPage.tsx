import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useProject } from '../hooks/useProject';
import { useTasks } from '../hooks/useTasks';
import { TaskList } from '../components/tasks/TaskList';
import { TaskFilters } from '../components/tasks/TaskFilters';
import { Pagination } from '../components/ui/Pagination';
import { ToggleSwitch } from '../components/ui/ToggleSwitch';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { api } from '../lib/api';
import { Spinner } from '../components/ui/Spinner';
import { EventHistoryDialog } from '../components/ui/EventHistoryDialog';
import { toast } from 'react-toastify';

const PAGE_SIZE = 25;

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, loading: projectLoading } = useProject(projectId!);
  // Toolbar state (status, priority, page, view) lives in the URL search params so
  // it survives navigating into a task and back — component state reset on return.
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get('status') ?? '';
  const priorityFilter = searchParams.get('priority') ?? '';
  const view: 'cards' | 'list' = searchParams.get('view') === 'list' ? 'list' : 'cards';
  const pageParam = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageParam) && pageParam > 1 ? pageParam - 1 : 0;

  const updateParams = (updates: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, val] of Object.entries(updates)) {
        if (val) next.set(key, val);
        else next.delete(key);
      }
      return next;
    });
  };

  const handleStatusChange = (status: string) => updateParams({ status, page: null });
  const handlePriorityChange = (priority: string) => updateParams({ priority, page: null });
  const handleViewChange = (v: 'cards' | 'list') => updateParams({ view: v === 'list' ? 'list' : null });
  const goToPage = (p: number) => updateParams({ page: p > 0 ? String(p + 1) : null });

  const [projectEvents, setProjectEvents] = useState<any[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [showProjectEvents, setShowProjectEvents] = useState(false);
  const { tasks, loading: tasksLoading, error } = useTasks(
    projectId!,
    { status: statusFilter, priority: priorityFilter },
    { limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE },
  );
  const pageTasks = tasks.slice(0, PAGE_SIZE);
  const hasNext = tasks.length > PAGE_SIZE;

  useEffect(() => {
    let cancelled = false;
    async function loadProjectEvents() {
      if (!projectId) return;
      setEventsLoading(true);
      try {
        const ev = await api.get<any[]>(`/events?project_id=${projectId}`);
        if (!cancelled) setProjectEvents(ev);
      } catch (err) {
        console.error('Failed to load project events:', err);
      } finally {
        if (!cancelled) setEventsLoading(false);
      }
    }
    loadProjectEvents();
    return () => { cancelled = true; };
  }, [projectId]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [priority, setPriority] = useState('medium');
  const [creating, setCreating] = useState(false);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/tasks', {
        project_id: projectId,
        agent_id: 'operator',
        title,
        objective,
        priority,
        idempotency_key: crypto.randomUUID(),
      });
      setTitle('');
      setObjective('');
      setPriority('medium');
      setShowForm(false);
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  if (projectLoading) return <Spinner />;
  if (!project) return <div className="container"><p>Project not found.</p></div>;

  return (
    <div className="page">
      <div className="container">
        <PageHeader
          title={project.name}
          description={project.description || undefined}
          kicker="</project>"
          actions={
            <Button variant="primary" onClick={() => setShowForm(true)}>
              New Task
            </Button>
          }
        />

        {showForm && (
          <div className="modal-overlay" onClick={() => setShowForm(false)}>
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label="New task"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-banner">
                <span className="code-tag">{'</new-task>'}</span>
                <button className="modal-close" onClick={() => setShowForm(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <form className="modal-body" onSubmit={handleCreateTask}>
                <Input label="Task Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
                <Input label="Objective" value={objective} onChange={(e) => setObjective(e.target.value)} />
                <Select
                  label="Priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  options={[
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                  ]}
                />
                <Button variant="primary" type="submit" disabled={creating}>
                  {creating ? 'Creating...' : 'Create Task'}
                </Button>
              </form>
            </div>
          </div>
        )}

        <div className="task-toolbar">
          <div className="task-toolbar-left">
            <TaskFilters
              status={statusFilter}
              priority={priorityFilter}
              onStatusChange={handleStatusChange}
              onPriorityChange={handlePriorityChange}
            />
            <ToggleSwitch
              ariaLabel="Task view"
              options={[
                { value: 'cards', label: 'Cards' },
                { value: 'list', label: 'List' },
              ]}
              value={view}
              onChange={handleViewChange}
            />
          </div>
          <Pagination
            page={page}
            hasNext={hasNext}
            onPrev={() => goToPage(Math.max(0, page - 1))}
            onNext={() => goToPage(page + 1)}
          />
        </div>

        <TaskList tasks={pageTasks} loading={tasksLoading} error={error} view={view} />

        {/* Project-level history (task-less events) */}
        <div className="mt-lg">
          <h2 className="section-subtitle">Project Activity</h2>
          {eventsLoading ? (
            <Spinner />
          ) : projectEvents.length === 0 ? (
            <div className="empty-box">No project-level activity yet.</div>
          ) : (
            <>
              <div className="empty-box">{projectEvents.length} event(s) recorded.</div>
              <Button variant="secondary" size="sm" onClick={() => setShowProjectEvents(true)}>
                View all events
              </Button>
            </>
          )}
        </div>
        <EventHistoryDialog
          scope={{ project_id: projectId! }}
          open={showProjectEvents}
          onClose={() => setShowProjectEvents(false)}
          title="Project activity"
        />
      </div>
    </div>
  );
}
