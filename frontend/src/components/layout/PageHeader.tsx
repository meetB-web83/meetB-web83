import { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Monospace syntax tag rendered above the title, e.g. "</projects>". */
  kicker?: string;
}

export function PageHeader({ title, description, actions, kicker }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        {kicker && (
          <div className="page-kicker">
            <span className="code-tag">{kicker}</span>
          </div>
        )}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
