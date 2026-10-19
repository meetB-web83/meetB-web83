import { useState, useEffect, useRef } from 'react';

export interface ScopeProject {
  id: string;
  name: string;
  available: boolean;
}

interface ProjectSelectProps {
  projects: ScopeProject[];
  /** null = all projects. */
  value: string | null;
  onChange: (projectId: string | null) => void;
}

/** Searchable project scope dropdown. Unavailable projects are shown but disabled. */
export function ProjectSelect({ projects, value, onChange }: ProjectSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = projects.find((p) => p.id === value);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  const pick = (projectId: string | null) => {
    onChange(projectId);
    setOpen(false);
  };

  return (
    <div className="project-select">
      <button type="button" className="project-select-button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="project-select-label">{selected ? selected.name : 'All projects'}</span>
        <span className="project-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <div className="project-select-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="project-select-panel" role="listbox">
            <input
              ref={searchRef}
              className="project-select-search"
              placeholder="Search projects..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search projects"
            />
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className={`project-select-option ${value === null ? 'project-select-option-active' : ''}`}
              onClick={() => pick(null)}
            >
              <span className="code-tag">[*]</span> All projects
            </button>
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={value === p.id}
                disabled={!p.available}
                className={`project-select-option ${value === p.id ? 'project-select-option-active' : ''}`}
                onClick={() => pick(p.id)}
                title={p.available ? p.name : `${p.name} (folder missing)`}
              >
                <span className="code-tag code-tag-ghost">{p.available ? '</>' : '×'}</span>
                {p.name}
                {!p.available && <span className="project-select-missing">missing</span>}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="project-select-empty">No projects match.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
