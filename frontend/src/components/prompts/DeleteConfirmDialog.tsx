import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';

interface DeleteConfirmDialogProps {
  promptName: string;
  onConfirm: () => void;
  onClose: () => void;
  submitting: boolean;
}

export function DeleteConfirmDialog({
  promptName,
  onConfirm,
  onClose,
  submitting,
}: DeleteConfirmDialogProps) {
  return createPortal(
    <div className="modal-overlay modal-overlay--raised" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Delete prompt"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-banner">
          <span className="code-tag">{'</delete>'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <h2 className="modal-title">Delete prompt</h2>
          <p className="modal-hint">
            Delete <strong>{promptName}</strong>? This cannot be undone.
          </p>
          <div className="modal-actions">
            <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" type="button" onClick={onConfirm} disabled={submitting}>
              {submitting ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
