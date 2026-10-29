import { FormEvent, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import type { Prompt, PromptFormValues } from './types';

const BASE_CATEGORIES = [
  { value: 'custom', label: 'Custom' },
  { value: 'builtin', label: 'Built-in' },
  { value: 'resume', label: 'Resume' },
  { value: 'checkpoint', label: 'Checkpoint' },
  { value: 'decision', label: 'Decision' },
  { value: 'handoff', label: 'Handoff' },
];

interface PromptFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  initial: Prompt | null;
  /** Human-readable scope shown as a hint, e.g. "global" or "this project". */
  scopeLabel: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: PromptFormValues) => void;
  onClose: () => void;
}

export function PromptFormDialog({
  open,
  mode,
  initial,
  scopeLabel,
  submitting,
  error,
  onSubmit,
  onClose,
}: PromptFormDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('custom');
  const [template, setTemplate] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setDescription(initial?.description ?? '');
    setCategory(initial?.category ?? 'custom');
    setTemplate(initial?.template ?? '');
  }, [open, initial]);

  if (!open) return null;

  // Keep an unknown stored category selectable instead of silently rewriting it.
  const categoryOptions = BASE_CATEGORIES.some((option) => option.value === category)
    ? BASE_CATEGORIES
    : [...BASE_CATEGORIES, { value: category, label: category }];

  const valid = name.trim().length > 0 && template.trim().length > 0;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    onSubmit({ name: name.trim(), description: description.trim(), category, template });
  };

  return createPortal(
    <div className="modal-overlay modal-overlay--raised" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? 'New prompt' : 'Edit prompt'}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-banner">
          <span className="code-tag">{'</prompt>'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form className="modal-body" onSubmit={handleSubmit}>
          <h2 className="modal-title">{mode === 'create' ? 'New prompt' : 'Edit prompt'}</h2>
          <p className="modal-hint">Scope: {scopeLabel}</p>
          <Input label="Name" value={name} onChange={(event) => setName(event.target.value)} required />
          <Input
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Select
            label="Category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            options={categoryOptions}
          />
          <Textarea
            label="Template"
            rows={7}
            className="prompt-template-input"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            required
          />
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <Button variant="primary" type="submit" disabled={!valid || submitting}>
              {submitting ? 'Saving...' : mode === 'create' ? 'Create prompt' : 'Save changes'}
            </Button>
            <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
