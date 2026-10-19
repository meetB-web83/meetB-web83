import { describe, it, expect } from 'vitest';
import { buildQueryString } from '@workjournal/mcp-adapter/query';

/**
 * Spec §9.9: the adapter must omit absent filters from forwarded GET query strings —
 * the original bug sent `status=&priority=`, which failed core's validation.
 */
describe('MCP adapter query building', () => {
  it('omits absent filters from list_tasks', () => {
    const qs = buildQueryString({ project_id: 'proj-1', status: undefined, priority: undefined, limit: 100, offset: 0 });
    expect(qs).toBe('?project_id=proj-1&limit=100&offset=0');
    expect(qs).not.toContain('status=');
    expect(qs).not.toContain('priority=');
  });

  it('omits empty-string and null filters', () => {
    const qs = buildQueryString({ project_id: 'proj-1', status: '', priority: null });
    expect(qs).toBe('?project_id=proj-1');
  });

  it('includes present filters', () => {
    const qs = buildQueryString({ project_id: 'proj-1', status: 'in_progress', priority: 'high', limit: 25, offset: 50 });
    expect(qs).toBe('?project_id=proj-1&status=in_progress&priority=high&limit=25&offset=50');
  });

  it('returns an empty string when nothing is set', () => {
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString({ status: undefined, priority: '' })).toBe('');
  });
});
