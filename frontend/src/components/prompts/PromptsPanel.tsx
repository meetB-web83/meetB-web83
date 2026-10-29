import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { toast } from 'react-toastify';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import { PromptCard } from './PromptCard';
import { PromptFormDialog } from './PromptFormDialog';
import { PromptPreviewDialog } from './PromptPreviewDialog';
import type { Prompt, PromptFormValues, PromptView } from './types';

export interface PromptsPanelHandle {
  openCreate: () => void;
}

interface PromptsPanelProps {
  /** When set, the panel manages this project's prompts plus inherited global rows. */
  projectId?: string;
}

interface FormState {
  mode: 'create' | 'edit';
  prompt: Prompt | null;
}

interface PreviewState {
  prompt: Prompt;
  rendered: string | null;
  loading: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}

function byName(a: Prompt, b: Prompt): number {
  return a.name.localeCompare(b.name);
}

/**
 * Project view: project rows win over same-named global/built-in rows (D-020).
 * The winning project row is badged "shadows global"; the shadowed row is hidden.
 * Everything else global is shown as read-only inherited context.
 */
function mergeResolved(projectRows: Prompt[], globalRows: Prompt[]): PromptView[] {
  const globalByName = new Map(globalRows.map((row) => [row.name, row]));
  const projectNames = new Set(projectRows.map((row) => row.name));
  const project = projectRows
    .map<PromptView>((row) => ({ ...row, shadowsGlobal: globalByName.has(row.name), inherited: false }))
    .sort(byName);
  const inherited = globalRows
    .filter((row) => !projectNames.has(row.name))
    .map<PromptView>((row) => ({ ...row, inherited: true }))
    .sort(byName);
  return [...project, ...inherited];
}

export const PromptsPanel = forwardRef<PromptsPanelHandle, PromptsPanelProps>(function PromptsPanel(
  { projectId },
  ref,
) {
  const [prompts, setPrompts] = useState<PromptView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);

  const load = useCallback(
    async (showSpinner = true) => {
      if (showSpinner) setLoading(true);
      try {
        if (projectId) {
          const [projectRows, globalRows] = await Promise.all([
            api.get<Prompt[]>(`/prompts?scope=project&project_id=${encodeURIComponent(projectId)}`),
            api.get<Prompt[]>('/prompts?scope=global'),
          ]);
          setPrompts(mergeResolved(projectRows, globalRows));
        } else {
          const rows = await api.get<Prompt[]>('/prompts?scope=global');
          setPrompts(rows.map((row) => ({ ...row, inherited: false })));
        }
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setFormError(null);
    setForm({ mode: 'create', prompt: null });
  };

  useImperativeHandle(ref, () => ({ openCreate }), []);

  const markBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => (busy ? [...prev, id] : prev.filter((value) => value !== id)));
  };

  const replaceRow = (updated: Prompt) => {
    setPrompts((prev) => prev.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)));
  };

  const openEdit = (prompt: Prompt) => {
    setFormError(null);
    setForm({ mode: 'edit', prompt });
  };

  const submitForm = async (values: PromptFormValues) => {
    if (!form) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (form.mode === 'create') {
        await api.post('/prompts', {
          ...values,
          project_id: projectId ?? null,
          idempotency_key: crypto.randomUUID(),
        });
      } else if (form.prompt) {
        await api.patch(`/prompts/${form.prompt.id}`, {
          ...values,
          expected_version: form.prompt.version,
          idempotency_key: crypto.randomUUID(),
        });
      }
      setForm(null);
      await load(false);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (prompt: Prompt, enabled: boolean) => {
    if (busyIds.includes(prompt.id)) return;
    markBusy(prompt.id, true);
    try {
      const updated = await api.post<Prompt>(`/prompts/${prompt.id}/toggle`, {
        enabled,
        expected_version: prompt.version,
        idempotency_key: crypto.randomUUID(),
      });
      replaceRow(updated);
    } catch (err) {
      toast.error(errorMessage(err));
      await load(false);
    } finally {
      markBusy(prompt.id, false);
    }
  };

  const remove = async (prompt: Prompt) => {
    if (!window.confirm(`Delete prompt "${prompt.name}"?`)) return;
    markBusy(prompt.id, true);
    try {
      await api.delete(`/prompts/${prompt.id}`);
      await load(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      markBusy(prompt.id, false);
    }
  };

  const openPreview = async (prompt: Prompt) => {
    setPreview({ prompt, rendered: null, loading: true, error: null });
    try {
      const result = await api.post<{ rendered: string }>(`/prompts/${prompt.id}/preview`, { args: {} });
      setPreview({ prompt, rendered: result.rendered, loading: false, error: null });
    } catch (err) {
      setPreview({ prompt, rendered: null, loading: false, error: errorMessage(err) });
    }
  };

  if (loading) return <Spinner />;

  if (error) {
    return (
      <div className="empty-box">
        <p className="error">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  const scopeLabel = projectId ? 'this project' : 'global';

  return (
    <>
      {prompts.length === 0 ? (
        <EmptyState
          title={projectId ? 'No project prompts yet' : 'No prompts'}
          description={
            projectId
              ? 'Create a prompt here to override a global prompt for this project.'
              : 'Create your first global prompt to get started.'
          }
          action={{ label: 'New prompt', onClick: openCreate }}
        />
      ) : (
        <div className="task-grid">
          {prompts.map((prompt) => (
            <PromptCard
              key={prompt.id}
              prompt={prompt}
              readOnly={prompt.inherited}
              onEdit={openEdit}
              onToggle={toggle}
              onPreview={openPreview}
              onDelete={remove}
            />
          ))}
        </div>
      )}

      <PromptFormDialog
        open={form !== null}
        mode={form?.mode ?? 'create'}
        initial={form?.prompt ?? null}
        scopeLabel={scopeLabel}
        submitting={submitting}
        error={formError}
        onSubmit={submitForm}
        onClose={() => {
          if (submitting) return;
          setForm(null);
          setFormError(null);
        }}
      />

      <PromptPreviewDialog
        prompt={preview?.prompt ?? null}
        rendered={preview?.rendered ?? null}
        loading={preview?.loading ?? false}
        error={preview?.error ?? null}
        onClose={() => setPreview(null)}
      />
    </>
  );
});
