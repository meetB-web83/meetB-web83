import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export interface BrowseEntry {
  name: string;
  path: string;
  has_workjournal: boolean;
}

interface BrowseResponse {
  current_path: string | null;
  parent_path: string | null;
  entries: BrowseEntry[];
}

interface FolderPickerProps {
  /** Initial directory; empty means filesystem roots. */
  initialPath?: string;
  onPick: (fullPath: string) => void;
  onClose: () => void;
}

/** Split a path into breadcrumb segments (drive-aware on Windows). */
function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.map((part, i) => ({
    label: part,
    path: normalized.startsWith('/') ? `/${parts.slice(0, i + 1).join('/')}` : parts.slice(0, i + 1).join('/'),
  }));
}

/**
 * Server-side folder picker modal. The browser File System Access API hides
 * absolute paths, so this browses via GET /api/projects/browse (loopback core
 * service) which returns real full paths. Single click drills in, double click
 * picks, "Use this folder" picks the current directory.
 */
export function FolderPicker({ initialPath, onPick, onClose }: FolderPickerProps) {
  const [path, setPath] = useState<string | null>(initialPath?.trim() || null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (debouncedSearch) params.set('search', debouncedSearch);
    const qs = params.toString();
    api
      .get<BrowseResponse>(`/projects/browse${qs ? `?${qs}` : ''}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [path, debouncedSearch]);

  const currentLabel = data?.current_path ?? 'Drives & roots';
  const crumbs = data?.current_path ? breadcrumbs(data.current_path) : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal folder-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Choose project folder"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-banner">
          <span className="code-tag">{'</choose-folder>'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="folder-picker-current">
            <span className="code-tag code-tag-ghost">&gt;_</span>
            <code className="folder-picker-path" title={currentLabel}>
              {currentLabel}
            </code>
          </div>
          {crumbs.length > 0 && (
            <nav className="folder-picker-crumbs" aria-label="Breadcrumb">
              <button type="button" className="folder-crumb" onClick={() => setPath(null)} title="Filesystem roots">
                [roots]
              </button>
              {crumbs.map((c) => (
                <span key={c.path}>
                  <span className="folder-crumb-sep" aria-hidden="true">/</span>
                  <button type="button" className="folder-crumb" onClick={() => setPath(c.path)} title={c.path}>
                    {c.label}
                  </button>
                </span>
              ))}
            </nav>
          )}
          <div className="folder-picker-toolbar">
            <input
              className="input folder-picker-search"
              placeholder="Filter folders..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Filter folders"
            />
            {data?.parent_path && (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setPath(data.parent_path)}>
                <span className="btn-label">Up</span>
              </button>
            )}
          </div>
          {loading ? (
            <p className="text-body">Loading folders…</p>
          ) : error ? (
            <p className="text-body">
              Error: {error}{' '}
              <button type="button" className="folder-crumb" onClick={() => setPath(null)}>
                Back to roots
              </button>
            </p>
          ) : !data || data.entries.length === 0 ? (
            <p className="text-body">No subfolders here. Use this folder or go up.</p>
          ) : (
            <ul className="folder-picker-list" role="listbox" aria-label="Subfolders">
              {data.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="folder-picker-row"
                    onClick={() => setPath(entry.path)}
                    onDoubleClick={() => {
                      onPick(entry.path);
                      onClose();
                    }}
                    title={`${entry.path}${entry.has_workjournal ? ' — has .workjournal' : ''}`}
                  >
                    <span className="code-tag code-tag-ghost">[dir]</span>
                    <span className="folder-picker-name">{entry.name}</span>
                    {entry.has_workjournal && <span className="code-tag code-tag-mint">[wj]</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="folder-picker-actions">
            <button
              type="button"
              className="btn btn-primary btn-md"
              disabled={!data?.current_path}
              onClick={() => {
                if (data?.current_path) {
                  onPick(data.current_path);
                  onClose();
                }
              }}
            >
              <span className="btn-label">Use this folder</span>
              <span className="btn-arrow" aria-hidden="true">↗</span>
            </button>
            <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>
              <span className="btn-label">Cancel</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
