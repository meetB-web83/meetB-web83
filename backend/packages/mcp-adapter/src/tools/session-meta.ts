/**
 * Session correlation helpers (WS-2.5).
 *
 * OpenCode attaches `_meta: { "ai.opencode/sessionID": "<id>" }` to MCP
 * tool-call requests. The adapter forwards it to Core as `session_id` on
 * claim-like calls so Core can bind session → task (migration 002b); the
 * session-binding table then lets plugin ingestion events carry task_id.
 *
 * Duck-typed on purpose: no dependency on SDK request types, so this stays a
 * pure function that is trivially unit-testable.
 */
export const OPENCODE_SESSION_META_KEY = 'ai.opencode/sessionID';

export function extractSessionId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>)[OPENCODE_SESSION_META_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
