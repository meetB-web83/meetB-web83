import { createPortal } from 'react-dom';
import { Spinner } from '../ui/Spinner';
import type { Prompt } from './types';

interface PromptPreviewDialogProps {
  prompt: Prompt | null;
  rendered: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

export function PromptPreviewDialog({ prompt, rendered, loading, error, onClose }: PromptPreviewDialogProps) {
  if (!prompt) return null;

  return createPortal(
    <div className="modal-overlay modal-overlay--raised" onClick={onClose}>
      <div
        className="modal modal--preview"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${prompt.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-banner">
          <span className="code-tag">{'</preview>'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <h2 className="modal-title">{prompt.name}</h2>
          {loading ? (
            <Spinner />
          ) : error ? (
            <p className="error">{error}</p>
          ) : (
            <>
              <pre className="prompt-preview">{rendered}</pre>
              <p className="prompt-preview-note">
                Rendered with no arguments; {'{{placeholders}}'} are shown as-is.
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
