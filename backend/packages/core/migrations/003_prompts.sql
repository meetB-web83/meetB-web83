-- 003_prompts.sql — dual-scope prompts (D-020, plan §8.1, WS-7.1)
-- Persist prompts as data rows in the registry DB so user edits survive upgrades.
-- Scope: project_id NULL = global; project_id set = project-scoped (shadowing).
-- Partial unique indexes work around SQLite treating NULLs as distinct.

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  template TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '[]',
  project_id TEXT REFERENCES registry_projects(id),
  is_builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Global scope: unique name among project_id IS NULL rows.
CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_name_global
  ON prompts(name) WHERE project_id IS NULL;

-- Project scope: unique name within a project.
CREATE UNIQUE INDEX IF NOT EXISTS ux_prompts_name_project
  ON prompts(name, project_id) WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id);
CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);

-- Idempotent seeding of the 4 built-in prompts (global scope).
-- ON CONFLICT DO NOTHING so a user edit to a built-in survives re-seed.
INSERT INTO prompts (id, name, description, category, template, arguments, project_id, is_builtin, enabled, version, created_at, updated_at)
VALUES
  ('builtin_resume_task', 'resume_task', 'Resume a task from its latest checkpoint', 'builtin', 'Resume task {{task_id}} from its latest checkpoint and continue.', '[]', NULL, 1, 1, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('builtin_create_checkpoint', 'create_checkpoint', 'Create a checkpoint for a task', 'builtin', 'Create a checkpoint for task {{task_id}} summarizing progress.', '[]', NULL, 1, 1, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('builtin_record_decision', 'record_decision', 'Record a decision on a task', 'builtin', 'Record decision on task {{task_id}}: {{statement}}.', '[]', NULL, 1, 1, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('builtin_review_handoff', 'review_handoff', 'Review a handoff for a task', 'builtin', 'Review handoff for task {{task_id}}.', '[]', NULL, 1, 1, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
ON CONFLICT (name) WHERE project_id IS NULL DO NOTHING;