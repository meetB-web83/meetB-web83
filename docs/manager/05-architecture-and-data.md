# 05 — Architecture & Data

Companion to the overview for the technical reviewer. Authoritative details
live in root `AGENTS.md`, `docs/decisions.md` (D-001…D-008), and
`docs/specs/`.

## System map

```
┌─────────────┐   stdio (MCP)   ┌──────────────┐   HTTP 127.0.0.1:3737   ┌──────────────┐
│ AI agent(s) │ ◀──────────────▶ │ MCP adapter  │ ◀─────────────────────▶ │ Core service │
└─────────────┘                 │ (thin, no DB)│                         │ (all logic   │
┌─────────────┐   HTTP /api *   └──────────────┘                         │  + all SQLite)│
│ Dashboard   │ ◀──────────────────────────────────────────────────────▶ │ Fastify      │
│ (React+Vite)│   (Vite proxies /api → :3737 in dev)                    └──────┬───────┘
└─────────────┘                                                                │
                                                        ┌──────────────────────┘
                                                        ▼
                                    ┌─────────────────────────────────────────┐
                                    │ ~/.workjournal/registry.db (index only) │
                                    │ <each-root>/.workjournal/workjournal.db │
                                    └─────────────────────────────────────────┘
```

## Packages (monorepo)

| Path | Role |
|------|------|
| `backend/packages/shared` | Zod schemas (single contract), error catalog, types. Imported by core, adapter, tests |
| `backend/packages/core` | Fastify service: `http/routes/*`, `domain/*-service.ts`, `db/` (connection, migrations, `ProjectDbResolver`), `config.ts`, `main.ts` |
| `backend/packages/mcp-adapter` | stdio MCP server: `tools/register.ts`, `tools/query.ts`, `client.ts` |
| `backend/tests` | Vitest: `integration/*`, `e2e/*`, `helpers/registry-factory.ts` (real SQLite in temp dirs, never mocked) |
| `frontend/src` | `pages/`, `components/` (ui, layout, tasks, projects), `hooks/`, `lib/api.ts`, `styles/` (tokens + global) |

## Data model (essentials)

- **Registry** (`registry_projects` + `registry_idempotency`): project id, name,
  root path (raw as typed; normalized win32-only via `normalizeRootPath` before
  fs access), timestamps. Rebuildable index.
- **Project DB** (`projects` authoritative copy, `tasks`, `events`, `checkpoints`,
  `decisions`, idempotency records): the source of truth, migrated lazily per
  DB with pre-migration backups.
- **Events** append-only, per-task monotonic sequence. **Checkpoints/decisions**
  store `expected_version` as observed but don't bump it (D-004). **Handoffs**
  are secret-filtered.
- **Dashboard read model:** `DashboardService.getOverview` — one call returns
  `{ stats, recent_tasks, projects }`. `project_id` scopes task stats + recents
  (task counts only); `stats.projects` is always the registry total and the
  project list always global (D-008 + the scope-independence fix).

## Key endpoints (see in-app `/docs/api` for the full table)

| Method & path | Purpose |
|---------------|---------|
| `POST /api/projects` (+ `GET`, `GET /:id`, `PATCH /:id`) | Register/list/fetch/rename. Idempotent by root path; init creates `<root>/.workjournal` |
| `GET /api/projects/browse?path=&search=` | Read-only folder browser for the picker. Empty path → drives/roots; directories only, 200 cap, `[wj]` markers |
| `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, `PATCH`, `…/claim`, `…/release`, `…/transition` | Task lifecycle (transition fn is the only status writer) |
| `POST /api/checkpoints`, `POST /api/decisions`, `POST /api/decisions/:id/supersede` | Continuity records |
| `GET /api/events?task_id=`, `GET /api/resume?task_id=`, `GET /api/export/:format?task_id=` | History, resume brief, handoffs |
| `GET /api/dashboard?project_id=&recent_limit=` | Stats + recents + project list |

## Guarantees that matter for review

- No auth by design (loopback bind + Zod + 1MB body cap + secret filtering +
  no secrets in logs). No Host/Origin checks yet.
- Parameterized queries only; dashboard escapes user content (React default,
  never `dangerouslySetInnerHTML`).
- UTC in storage; local time only at render. Deterministic resume/exports
  (`ORDER BY` + tiebreakers). Timestamps, versions, and idempotency make every
  retry safe and every handoff reproducible.
