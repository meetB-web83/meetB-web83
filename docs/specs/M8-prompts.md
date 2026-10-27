# Spec — M8: Prompt persistence + Core API + MCP resolution (post-MVP)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §2 (D-020), §8 (WS-7), §11.1
Source of truth: this spec captures plan §8.1–§8.5 and D-020 verbatim where quoted; docs-only, no code or migration files.

## 1. Purpose

Pin the prompts contract (registry DB table, dual-scope shadowing, REST API, MCP resolution) so WS-7 implements prompt CRUD against a single reviewable reference.

## 2. Persistence — migration `003_prompts.sql` (registry DB) — plan §8.1

```sql
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom',   -- resume | checkpoint | decision | handoff | custom
  template TEXT NOT NULL,                    -- message template with {{arg}} placeholders
  arguments TEXT NOT NULL DEFAULT '[]',      -- JSON: [{name, description, required, type}]
  project_id TEXT REFERENCES registry_projects(id),  -- NULL = global scope (D-020)
  is_builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Name uniqueness per scope (SQLite UNIQUE treats NULLs as distinct):
CREATE UNIQUE INDEX ux_prompts_name_global ON prompts(name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX ux_prompts_name_project ON prompts(name, project_id) WHERE project_id IS NOT NULL;
```

Seeded built-ins (`resume_task`, `create_checkpoint`, `record_decision`, `review_handoff`) are inserted idempotently (`ON CONFLICT DO NOTHING` against the global unique index) so user edits survive upgrades. Built-ins are editable as overrides (version bump recorded) and duplicable; they are never hard-deleted (API returns `BUILTIN_PROMPT_PROTECTED`). Templates are plain text + validated `{{arg}}` placeholders — no code execution, no bypass of ownership or transition checks; any action prompted still goes through the normal MCP tool.

## 3. Scope — dual-scope with shadowing (D-020, plan §8.1)

- `project_id` NULL = global scope; set = a project prompt semantically owned by that registered project.
- Prompts are stored in the **registry DB** so one API/dashboard/MCP sync serves both scopes; project DBs remain pure per-project state — prompts are **not** stored in project DBs.
- Project rows shadow same-named global prompts or built-ins **for that project only**; shadowing never modifies the global row and other projects are unaffected (dashboard shows "shadows global" badges).
- MCP adapter resolves project scope by matching its working directory against registered project roots (no match → global prompts only) and re-reads the registry on change to re-register dynamically.

## 4. Core API (plan §8.2)

| Endpoint | Notes |
|---|---|
| `GET /api/prompts` | filters: `scope=global\|project`, `project_id`, category, enabled, include_builtin; `resolved=1` returns the effective set for a project (project shadows global/built-in by name) |
| `POST /api/prompts` | Zod-validated; `project_id` optional (absent = global); idempotency key; name unique within its scope |
| `GET /api/prompts/{id}` | `404` → `NotFoundError` |
| `PATCH /api/prompts/{id}` | optimistic version check; idempotency; scope immutable after creation |
| `DELETE /api/prompts/{id}` | custom only; builtin → `400 BUILTIN_PROMPT_PROTECTED` |
| `POST /api/prompts/{id}/toggle` | enable/disable |
| `POST /api/prompts/{id}/preview` | render template with sample args; validation errors surfaced |

Follows existing validation-hook + error-catalog conventions.

**Resolution order for a given name within a project:** project-scoped row → global custom row → built-in; a **disabled winner hides the name entirely** — no fall-through to the shadowed row (disabling is a real removal of that name for the project).

## 5. MCP prompt resolution (plan §8.4)

MCP has no notion of "current project", so the adapter resolves scope by matching its working directory against registered project roots (OpenCode spawns local MCP servers with the workspace as cwd — confirmed behavior). A `WORKJOURNAL_PROJECT_ID` environment escape hatch is added to the MCP entry for clients that spawn with a different cwd.

- Registered match → effective set = project rows shadowing global/built-in names.
- No match → global prompts only.
- The name→id map is built from the resolved effective set, so two projects connected simultaneously (each with its own adapter process) see their own scope.
- Adapter maintains a name→id map; deleted/disabled prompts are treated as "render returns an explanatory error" until the session restarts (documented client-facing limitation; workaround: reconnect or ignore cached list).

## 6. Prompt behavior guarantees (plan §8.5)

- `resume_task` guides the client to read the resume resource then call `claim_task`; retrieving a prompt performs no mutation.
- Prompts never contain secrets and are secret-filtered on export like other content (root AGENTS.md).

## 7. Verification (docs-only)

- Table shape, unique indexes per scope, D-020 dual-scope shadowing, disabled-winner-hides rule, and the REST endpoint table trace to plan §8.1–§8.4.
- `003_prompts.sql` is named exactly as in plan §11.1; no other migration filenames invented.
- git diff for this session contains `docs/specs/*` only.