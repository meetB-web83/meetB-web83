import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Textarea } from '../ui/Textarea';

/** Preview plan entry (spec §6.2 statuses). */
interface PreviewPath {
  path: string;
  status: string;
  reason?: string;
}

interface PreviewResponse {
  task_id: string;
  target: { id: string; kind: string; sequence: number; commit_sha: string | null; capture_status: string };
  effective: { id: string; kind: string; sequence: number; commit_sha: string | null; capture_status: string };
  paths: PreviewPath[];
  summary: Record<string, number>;
  would_restore: string[];
  would_delete: string[];
  skipped_by_default: string[];
  preview_id: string;
}

export interface ApplyResponse {
  target_snapshot_id: string;
  target_kind: string;
  effective_snapshot_id: string;
  safety_snapshot_id: string;
  safety_snapshot_sha: string;
  rollback_snapshot_id: string;
  rollback_snapshot_sha: string;
  reverted_paths: string[];
  deleted_paths: string[];
  skipped_paths: Array<{ path: string; reason: string }>;
  failed_paths: Array<{ path: string; reason: string }>;
  rolled_back_checkpoint_ids: string[];
  applied_at: string;
}

interface Props {
  taskId: string;
  open: boolean;
  /** Snapshot id, or 'baseline'. */
  target: string;
  /** Human label for the target, e.g. "checkpoint cp-123". */
  targetLabel: string;
  /** Prefilled reason (undo flow). */
  initialReason?: string;
  onClose: () => void;
  onApplied?: (result: ApplyResponse) => void;
}

type Phase = 'loading' | 'ready' | 'applying' | 'done' | 'failed';

const STATUS_ORDER = [
  'clean',
  'restore',
  'delete',
  'missing',
  'changed-since',
  'conflict',
  'not-restorable',
];

/**
 * Preview → reason → confirm → apply flow for rolling a task's working tree
 * back to a target snapshot (Addendum B §B9). The dashboard always acts as
 * `operator`. The preview is read-only; apply carries a one-shot idempotency
 * key and a required reason.
 */
export function RollbackDialog({ taskId, open, target, targetLabel, initialReason = '', onClose, onApplied }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [reason, setReason] = useState(initialReason);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ApplyResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('loading');
    setPreview(null);
    setError('');
    setResult(null);
    setReason(initialReason);
    (async () => {
      try {
        const res = await api.post<PreviewResponse>(`/tasks/${taskId}/revert/preview`, {
          task_id: taskId,
          agent_id: 'operator',
          target,
        });
        if (cancelled) return;
        setPreview(res);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId, target]);

  if (!open) return null;

  const apply = async () => {
    if (!preview) return;
    if (!reason.trim()) {
      setError('A reason is required to roll back.');
      return;
    }
    setPhase('applying');
    setError('');
    try {
      const res = await api.post<ApplyResponse>(`/tasks/${taskId}/revert`, {
        task_id: taskId,
        agent_id: 'operator',
        target,
        preview_id: preview.preview_id,
        reason: reason.trim(),
        idempotency_key: crypto.randomUUID(),
      });
      setResult(res);
      setPhase('done');
      onApplied?.(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('ready');
    }
  };

  const summary = preview?.summary ?? {};

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Roll back to ${targetLabel}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(760px, 100%)', maxWidth: '760px' }}
      >
        <div className="modal-banner">
          <span className="code-tag">{'<rollback>'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="modal-body">
          <h3 className="modal-title">Roll back to {targetLabel}</h3>

          {phase === 'loading' && <Spinner />}

          {(phase === 'ready' || phase === 'applying') && preview && (
            <>
              <div className="rollback-plan-meta">
                <span className="code-tag">
                  target: {preview.target.kind} seq {preview.target.sequence}
                </span>
                <span className="code-tag">
                  from effective: {preview.effective.kind} seq {preview.effective.sequence}
                </span>
                <span className="code-tag">{preview.paths.length} path(s) in plan</span>
              </div>

              <div className="rollback-summary-grid">
                {STATUS_ORDER.filter((s) => (summary[s] ?? 0) > 0 || s === 'clean' || s === 'restore').map(
                  (s) => (
                    <div key={s} className="rollback-summary-cell">
                      <span className="rollback-summary-count">{summary[s] ?? 0}</span>
                      <span className="rollback-summary-label">{s}</span>
                    </div>
                  ),
                )}
              </div>

              {preview.would_restore.length > 0 && (
                <div className="rollback-paths">
                  <strong>Will restore ({preview.would_restore.length}):</strong>
                  <ul>
                    {preview.would_restore.slice(0, 40).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                    {preview.would_restore.length > 40 && <li>… {preview.would_restore.length - 40} more</li>}
                  </ul>
                </div>
              )}
              {preview.would_delete.length > 0 && (
                <div className="rollback-paths">
                  <strong>Will delete ({preview.would_delete.length}):</strong>
                  <ul>
                    {preview.would_delete.slice(0, 40).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                    {preview.would_delete.length > 40 && <li>… {preview.would_delete.length - 40} more</li>}
                  </ul>
                </div>
              )}
              {preview.skipped_by_default.length > 0 && (
                <div className="rollback-paths rollback-paths--warn">
                  <strong>Skipped unless forced ({preview.skipped_by_default.length}):</strong>
                  <ul>
                    {preview.skipped_by_default.slice(0, 40).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                    {preview.skipped_by_default.length > 40 && (
                      <li>… {preview.skipped_by_default.length - 40} more</li>
                    )}
                  </ul>
                  <p className="text-muted">Files changed after the last capture are left untouched.</p>
                </div>
              )}
              {preview.paths.length === 0 && (
                <div className="empty-box">Nothing to change — the tree already matches the target.</div>
              )}

              <Textarea
                label="Reason (required)"
                value={reason}
                maxLength={2000}
                rows={3}
                placeholder="Why this rollback is happening"
                onChange={(e) => setReason(e.target.value)}
              />

              {error && <p className="rollback-error">{error}</p>}

              <div className="modal-actions">
                <Button variant="secondary" onClick={onClose} disabled={phase === 'applying'}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={apply}
                  disabled={phase === 'applying' || !reason.trim()}
                >
                  {phase === 'applying' ? 'Rolling back…' : 'Roll back'}
                </Button>
              </div>
            </>
          )}

          {phase === 'done' && result && (
            <div className="rollback-done">
              <p>
                <strong>Rolled back</strong> to {result.target_kind} snapshot{' '}
                <span className="code-tag">{result.target_snapshot_id}</span>
              </p>
              <div className="rollback-summary-grid">
                <div className="rollback-summary-cell">
                  <span className="rollback-summary-count">{result.reverted_paths.length}</span>
                  <span className="rollback-summary-label">reverted</span>
                </div>
                <div className="rollback-summary-cell">
                  <span className="rollback-summary-count">{result.deleted_paths.length}</span>
                  <span className="rollback-summary-label">deleted</span>
                </div>
                <div className="rollback-summary-cell">
                  <span className="rollback-summary-count">{result.skipped_paths.length}</span>
                  <span className="rollback-summary-label">skipped</span>
                </div>
                <div className="rollback-summary-cell">
                  <span className="rollback-summary-count">{result.failed_paths.length}</span>
                  <span className="rollback-summary-label">failed</span>
                </div>
              </div>
              <p className="text-muted">
                Safety snapshot: <span className="code-tag">{result.safety_snapshot_id}</span> — use “Undo
                this rollback” to restore it.
              </p>
              {result.rolled_back_checkpoint_ids.length > 0 && (
                <p className="text-muted">
                  Rolled-back checkpoints: {result.rolled_back_checkpoint_ids.join(', ')}
                </p>
              )}
              <div className="modal-actions">
                <Button variant="primary" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          )}

          {phase === 'failed' && (
            <>
              <p className="rollback-error">{error}</p>
              <div className="modal-actions">
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
