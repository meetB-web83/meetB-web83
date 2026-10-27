-- 002b_session_task_binding.sql — session↔task correlation map (plan §2/D-023, WS-2.5)
--
-- The MCP adapter forwards OpenCode's `ai.opencode/sessionID` tool-call `_meta`
-- with claim-like tool calls; Core records a binding so later plugin ingestion
-- events for the same session are backfilled with task_id. Events without an
-- active binding stay project-level (task_id NULL, plan §3.1).
--
-- One ACTIVE binding per session (partial unique index on session_id where
-- released_at IS NULL); a task may hold several bindings (recovery attempts).

CREATE TABLE session_task_bindings (
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX idx_session_bindings_active ON session_task_bindings(session_id) WHERE released_at IS NULL;
CREATE INDEX idx_session_bindings_task ON session_task_bindings(task_id);
