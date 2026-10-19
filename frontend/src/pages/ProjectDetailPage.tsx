import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useProject } from '../hooks/useProject';
import { useTasks } from '../hooks/useTasks';
import { TaskList } from '../components/tasks/TaskList';
import { TaskFilters } from '../components/tasks/TaskFilters';
import { Pagination } from '../components/ui/Pagination';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { api } from '../lib/api';
import { Spinner } from '../components/ui/Spinner';
import { toast } from 'react-toastify';

const PAGE_SIZE = 25;

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, loading: projectLoading } = useProject(projectId!);
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [page, setPage] = useState(0);
  const { tasks, loading: tasksLoading, error } = useTasks(
    projectId!,
    { status: statusFilter, priority: priorityFilter },
    { limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE },
  );
  const pageTasks = tasks.slice(0, PAGE_SIZE);
  const hasNext = tasks.length > PAGE_SIZE;

  useEffect(() => {
    setPage(0);
  }, [projectId, statusFilter, priorityFilter]);
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

        <TaskFilters
          status={statusFilter}
          priority={priorityFilter}
          onStatusChange={setStatusFilter}
          onPriorityChange={setPriorityFilter}
        />

        <TaskList tasks={pageTasks} loading={tasksLoading} error={error} />
        <Pagination
          page={page}
          hasNext={hasNext}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => p + 1)}
        />
      </div>
    </div>
  );
}
