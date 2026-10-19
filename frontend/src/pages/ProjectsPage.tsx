import { useState } from 'react';
import { useProjects } from '../hooks/useProjects';
import { ProjectList } from '../components/projects/ProjectList';
import { FolderPicker } from '../components/projects/FolderPicker';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api } from '../lib/api';
import { toast } from 'react-toastify';

/**
 * Parent of the currently typed path, used to seed the server-side folder
 * picker (which returns real full paths, unlike the browser File System
 * Access API that only reveals the folder name).
 */
function parentDirOf(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}

export function ProjectsPage() {
  const { projects, loading, error } = useProjects();
  const [showForm, setShowForm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [creating, setCreating] = useState(false);

  /**
   * Server-side folder picker: returns real full paths via
   * GET /api/projects/browse. The native showDirectoryPicker fallback is gone —
   * it only ever yielded the bare folder name, which then failed backend
   * validation ("folder does not exist"). Manual typing stays as fallback.
   */
  const handleBrowse = () => {
    setShowPicker(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/projects', { name, description, root_path: rootPath, idempotency_key: crypto.randomUUID() });
      setName('');
      setDescription('');
      setRootPath('');
      setShowForm(false);
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <div className="container">
        <PageHeader
          title="Projects"
          description="Manage your WorkJournal projects and their tasks."
          kicker="</projects>"
          actions={
            <Button variant="primary" onClick={() => setShowForm(true)}>
              New Project
            </Button>
          }
        />

        {showForm && (
          <div className="modal-overlay" onClick={() => setShowForm(false)}>
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label="New project"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-banner">
                <span className="code-tag">{'</new-project>'}</span>
                <button className="modal-close" onClick={() => setShowForm(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <form className="modal-body" onSubmit={handleCreate}>
                <Input label="Project Name" value={name} onChange={(e) => setName(e.target.value)} required />
                <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
                <div className="input-group">
                  <label className="input-label">Root Path</label>
                  <div className="path-input-row">
                    <input
                      className="input"
                      value={rootPath}
                      onChange={(e) => setRootPath(e.target.value)}
                      placeholder="/path/to/project"
                      required
                      aria-label="Root Path"
                    />
                    <Button variant="outline" type="button" arrow={false} onClick={handleBrowse}>
                      Browse
                    </Button>
                  </div>
                  <span className="path-hint">Browse to pick the full path, or type it manually.</span>
                </div>
                <Button variant="primary" type="submit" disabled={creating}>
                  {creating ? 'Creating...' : 'Create Project'}
                </Button>
              </form>
            </div>
          </div>
        )}

        {showPicker && (
          <FolderPicker
            initialPath={parentDirOf(rootPath) ?? rootPath}
            onPick={(fullPath) => setRootPath(fullPath)}
            onClose={() => setShowPicker(false)}
          />
        )}

        <ProjectList projects={projects} loading={loading} error={error} />
      </div>
    </div>
  );
}
