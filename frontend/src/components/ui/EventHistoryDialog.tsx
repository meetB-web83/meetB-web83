import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Button } from './Button';
import { Spinner } from './Spinner';

interface EventRow {
  id: string;
  event_id: string | null;
  project_id: string;
  task_id: string | null;
  sequence: number;
  actor: string;
  event_type: string;
  category: string;
  source: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

interface Props {
  scope: { task_id?: string; project_id?: string };
  open: boolean;
  onClose: () => void;
  title?: string;
}

const PAGE_SIZE = 50;

function payloadSummary(payload: Record<string, unknown>): string {
  if (!payload) return '';
  const parts: string[] = [];
  if (payload.reason) parts.push(`reason: ${payload.reason}`);
  if (payload.from && payload.to) parts.push(`${payload.from} -> ${payload.to}`);
  if (payload.title) parts.push(`title: ${payload.title}`);
  if (payload.summary) parts.push(String(payload.summary));
  if (payload.resolution_note) parts.push(`note: ${payload.resolution_note}`);
  if (parts.length === 0) {
    try {
      const s = JSON.stringify(payload);
      return s.length > 90 ? s.slice(0, 90) + '...' : s;
    } catch {
      return '';
    }
  }
  return parts.join('  ');
}

export function EventHistoryDialog({ scope, open, onClose, title }: Props) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (scope.task_id) params.set('task_id', scope.task_id);
        if (scope.project_id) params.set('project_id', scope.project_id);
        params.set('limit', String(PAGE_SIZE + 1));
        params.set('offset', String(offset));
        const ev = await api.get<EventRow[]>(`/events?${params.toString()}`);
        if (cancelled) return;
        setHasMore(ev.length > PAGE_SIZE);
        setEvents(ev.slice(0, PAGE_SIZE));
      } catch (err) {
        console.error('Failed to load events:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [open, scope.task_id, scope.project_id, offset]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Event history'}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(920px, 100%)', maxWidth: '920px' }}
      >
        <div className="modal-banner">
          <span className="code-tag">{'<event-history>'}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <Spinner />
          ) : events.length === 0 ? (
            <div className="empty-box">No events recorded yet.</div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>Timestamp</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>Category</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>Source</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>Event type</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev) => (
                      <tr key={ev.id}>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{formatDateTime(ev.created_at)}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <span className={`timeline-event-badge category-${ev.category}`}>{ev.category}</span>
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <span className={`timeline-event-badge source-${ev.source.split(':')[0]}`}>{ev.source}</span>
                        </td>
                        <td style={{ padding: '6px 8px' }}>{ev.event_type}</td>
                        <td style={{ padding: '6px 8px' }}>{payloadSummary(ev.payload)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
                <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  Prev
                </Button>
                <span className="text-muted">Showing {offset + 1}-{offset + events.length}</span>
                <Button variant="secondary" size="sm" disabled={!hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>
                  Next
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
