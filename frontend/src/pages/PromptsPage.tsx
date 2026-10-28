import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Textarea } from '../components/ui/Textarea';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { PageHeader } from '../components/layout/PageHeader';
import { ToggleSwitch } from '../components/ui/ToggleSwitch';

interface Prompt {
  id: string;
  name: string;
  description: string | null;
  category: string;
  template: string;
  arguments: any[];
  project_id: string | null;
  is_builtin: boolean;
  enabled: boolean;
  version: number;
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [form, setForm] = useState({ name: '', description: '', category: 'custom', template: '', project_id: '' });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<Prompt[]>('/prompts');
      setPrompts(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async () => {
    try {
      const body: any = {
        name: form.name,
        description: form.description,
        category: form.category,
        template: form.template,
        project_id: form.project_id || null,
        idempotency_key: crypto.randomUUID(),
      };
      if (editing) {
        await api.patch(`/prompts/${editing.id}`, { ...body, expected_version: editing.version });
      } else {
        await api.post('/prompts', body);
      }
      setEditing(null);
      setForm({ name: '', description: '', category: 'custom', template: '', project_id: '' });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this prompt?')) return;
    try {
      await api.delete(`/prompts/${id}`);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggle = async (p: Prompt, to: boolean) => {
    try {
      await api.post(`/prompts/${p.id}/toggle`, { enabled: to, expected_version: p.version, idempotency_key: crypto.randomUUID() });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const preview = async (id: string) => {
    setPreviewId(id);
    try {
      const res = await api.post<{ rendered: string }>(`/prompts/${id}/preview`, { args: {} });
      setPreviewResult(res.rendered);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const startEdit = (p: Prompt) => {
    setEditing(p);
    setForm({ name: p.name, description: p.description || '', category: p.category, template: p.template, project_id: p.project_id || '' });
  };

  if (loading) return <Spinner />;

  return (
<div className="page">
      <div className="container">
        <PageHeader title="Prompts" description="Manage global and project-scoped prompts." kicker="</prompts>" />
      {error && <p className="error">{error}</p>}

        {prompts.length === 0 ? (
          <EmptyState title="No prompts" description="Create your first prompt to get started." action={{ label: 'New prompt', onClick: () => setEditing({} as Prompt) }} />
        ) : (
          <div className="task-grid">
            {prompts.map((p) => (
              <Card key={p.id} onClick={() => startEdit(p)} style={{ cursor: 'pointer' }}>
                <div className="task-card-header">
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong className="task-card-title">{p.name}</strong>
                    {p.is_builtin && <Badge>built-in</Badge>}
                    {p.project_id ? <Badge>project</Badge> : <Badge>global</Badge>}
                    {!p.enabled && <Badge>disabled</Badge>}
                  </div>
                  <ToggleSwitch
                    options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                    value={p.enabled ? 'on' : 'off'}
                    onChange={(v) => toggle(p, v === 'on')}
                    ariaLabel="Prompt enabled"
                  />
                </div>
                <div className="task-card-body">
                  {p.description && <p className="task-card-objective">{p.description}</p>}
                  <pre style={{ margin: '0.5rem 0', fontSize: '0.8rem' }}>{p.template}</pre>
                </div>
                <div className="task-card-footer" onClick={(e) => e.stopPropagation()}>
                  <Button variant="outline" onClick={() => preview(p.id)}>Preview</Button>
                  {!p.is_builtin && <Button variant="secondary" onClick={() => remove(p.id)}>Delete</Button>}
                  {previewId === p.id && previewResult !== null && <pre style={{ marginTop: '0.5rem', width: '100%' }}>{previewResult}</pre>}
                </div>
              </Card>
            ))}
          </div>
        )}

        {editing && (
          <div className="modal-overlay" onClick={() => setEditing(null)}>
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label={editing ? 'Edit prompt' : 'New prompt'}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-banner">
                <span className="code-tag">{'</prompt>'}</span>
                <button className="modal-close" onClick={() => setEditing(null)} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="modal-body">
                <h2 style={{ margin: '0 0 1rem' }}>{editing ? 'Edit prompt' : 'New prompt'}</h2>
                <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                <Input label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                <Textarea label="Template" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} />
                <Input label="Project ID (optional)" value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} />
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Button variant="primary" onClick={submit}>{editing ? 'Save' : 'Create'}</Button>
                  <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}