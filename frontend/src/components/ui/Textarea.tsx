import { TextareaHTMLAttributes, forwardRef } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = '', ...props }, ref) => {
    return (
      <div className="input-group">
        {label && <label className="input-label">{label}</label>}
        <textarea ref={ref} className={`textarea ${error ? 'input-error' : ''} ${className}`} {...props} />
        {error && <span className="input-error-text">{error}</span>}
      </div>
    );
  },
);

Textarea.displayName = 'Textarea';
