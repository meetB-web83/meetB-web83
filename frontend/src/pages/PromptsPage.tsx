import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Textarea } from '../components/ui/Textarea';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';

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
  const [previewArgs, setPreviewArgs] = useState('{}');
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

  const toggle = async (p: Prompt) => {
    try {
      await api.post(`/prompts/${p.id}/toggle`, { enabled: !p.enabled, expected_version: p.version, idempotency_key: crypto.randomUUID() });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const preview = async (id: string) => {
    try {
      const args = JSON.parse(previewArgs || '{}');
      const res = await api.post<{ rendered: string }>(`/prompts/${id}/preview`, { args });
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
    <div className="prompts-page">
      <h1>Prompts</h1>
      {error && <p className="error">{error}</p>}

      <Card>
        <h2>{editing ? 'Edit prompt' : 'New prompt'}</h2>
        <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Input label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <Textarea label="Template" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} />
        <Input label="Project ID (optional)" value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} />
        <Button onClick={submit}>{editing ? 'Save' : 'Create'}</Button>
        {editing && <Button onClick={() => { setEditing(null); setForm({ name: '', description: '', category: 'custom', template: '', project_id: '' }); }}>Cancel</Button>}
      </Card>

      {prompts.length === 0 ? (
        <EmptyState title="No prompts" />
      ) : (
        <div className="prompt-list">
          {prompts.map((p) => (
            <Card key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{p.name}</strong>
                  {p.is_builtin && <Badge>built-in</Badge>}
                  {p.project_id ? <Badge>project</Badge> : <Badge>global</Badge>}
                  {!p.enabled && <Badge>disabled</Badge>}
                </div>
                <div>
                  <Button onClick={() => toggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
                  <Button onClick={() => startEdit(p)}>Edit</Button>
                  {!p.is_builtin && <Button onClick={() => remove(p.id)}>Delete</Button>}
                </div>
              </div>
              {p.description && <p>{p.description}</p>}
              <pre>{p.template}</pre>
              <div>
                <Input label="Preview args (JSON)" value={previewArgs} onChange={(e) => setPreviewArgs(e.target.value)} />
                <Button onClick={() => preview(p.id)}>Preview</Button>
                {previewResult && <pre>{previewResult}</pre>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}