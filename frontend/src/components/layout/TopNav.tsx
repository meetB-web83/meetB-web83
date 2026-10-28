import { Link, useLocation } from 'react-router-dom';
import { ScopeSelect } from '../projects/ScopeSelect';

const links = [
  { to: '/', label: 'Home', accent: 'yellow' },
  { to: '/projects', label: 'Projects', accent: 'blue' },
  { to: '/prompts', label: 'Prompts', accent: 'lilac' },
  { to: '/docs', label: 'Docs', accent: 'lilac' },
] as const;

function isActive(pathname: string, to: string) {
  return to === '/' ? pathname === '/' : pathname.startsWith(to);
}

/** Sticky top navigation bar with a 2px structural bottom border. */
export function TopNav() {
  const location = useLocation();

  return (
    <nav className="top-nav" aria-label="Primary">
      <div className="top-nav-inner">
        <Link to="/" className="top-nav-brand" aria-label="WorkJournal home">
          <span className="brand-mark">W</span>
          <span className="brand-name">WorkJournal</span>
        </Link>
        <div className="top-nav-links">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={`top-nav-link ${isActive(location.pathname, l.to) ? `top-nav-link-active-${l.accent}` : ''}`}
            >
              {l.label}
            </Link>
          ))}
        </div>
        {location.pathname === '/' && (
          <div className="top-nav-scope">
            <span className="code-tag">&lt;scope&gt;</span>
            <ScopeSelect />
          </div>
        )}
        <div className="top-nav-actions" title="Core service">
          <span className="status-dot" />
        </div>
      </div>
    </nav>
  );
}
