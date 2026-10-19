/**
 * Query-string builder for GET forwards (spec §9.9): absent filters (undefined, null or
 * empty string) are omitted entirely, so `list_tasks` with only a project_id never sends
 * `status=` or `priority=` — the empty strings that used to fail core's validation.
 */
export function buildQueryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
