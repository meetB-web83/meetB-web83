import type { Database } from '../db/connection.js';

/**
 * Session ↔ task correlation map (plan §2/D-023, WS-2.5, migration 002b).
 *
 * The MCP adapter forwards OpenCode's `ai.opencode/sessionID` tool-call
 * `_meta` with claim-like tool calls; Core binds that session to the claimed
 * task so later plugin ingestion events for the same session are backfilled
 * with task_id. Unbound events stay project-level (task_id NULL, plan §3.1).
 *
 * One ACTIVE binding per session (partial unique index); claiming a new task
 * supersedes the session's previous binding, releasing a task ends its.
 */
export class SessionBindingService {
  constructor(private db: Database) {}

  bind(sessionId: string, projectId: string, taskId: string, agentId: string): void {
    const now = new Date().toISOString();
    // One active binding per session: end the previous one first.
    this.db.raw
      .prepare(
        'UPDATE session_task_bindings SET released_at = ? WHERE session_id = ? AND released_at IS NULL',
      )
      .run(now, sessionId);
    this.db.raw
      .prepare(
        `INSERT INTO session_task_bindings (session_id, project_id, task_id, agent_id, created_at, released_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(sessionId, projectId, taskId, agentId, now);
  }

  /** End every active binding for a task (called when a task is released). */
  releaseForTask(taskId: string): void {
    const now = new Date().toISOString();
    this.db.raw
      .prepare(
        'UPDATE session_task_bindings SET released_at = ? WHERE task_id = ? AND released_at IS NULL',
      )
      .run(now, taskId);
  }

  /** Active binding for a session, or null when unbound. */
  resolveActive(sessionId: string): { projectId: string; taskId: string } | null {
    const row = this.db.raw
      .prepare(
        'SELECT project_id, task_id FROM session_task_bindings WHERE session_id = ? AND released_at IS NULL',
      )
      .get(sessionId) as any;
    return row ? { projectId: row.project_id, taskId: row.task_id } : null;
  }
}
