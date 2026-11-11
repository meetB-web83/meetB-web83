# 04 — Connecting AI Agents via MCP

This is the technical heart of WorkJournal: how an AI coding agent (Cline,
Muse Spark, Claude, …) reads and writes task state. Non-technical reviewers can
skim §1–2 and skip to the review checklist (§6).

## 1. The big picture (plain language)

The agent never touches the database. It calls **tools** (like function calls:
"claim this task", "record a checkpoint") exposed over the **Model Context
Protocol (MCP)**. A thin adapter validates each call and forwards it to the
core service over loopback HTTP. The core does the real work and answers. If
the core is down, the agent gets "start the core service" — never silent
failure, never auto-start surprises.

```
Agent process ──stdio (MCP)──▶ workjournal-mcp ──HTTP 127.0.0.1:3737──▶ core ──▶ SQLite
```

## 2. The two transports (why two?)

| Layer | Protocol | Rule |
|-------|----------|------|
| Agent ↔ adapter | MCP over **stdio** (spawned per session, no port) | Validates with shared Zod schemas |
| Adapter ↔ core | Plain **HTTP on loopback** | Core owns ALL business logic + ALL SQLite |

Invariants (from root `AGENTS.md`, do-not-break): the adapter and dashboard
contain **zero** business logic and **never** open SQLite. One domain-level
transition function validates every status change. Events are append-only.

## 3. Wiring it up (for a technical reviewer)

**Prerequisites:** core service running (`backend → pnpm dev`, port 3737 or
`WORKJOURNAL_CORE_URL` override).

**Entry points** (`backend/packages/mcp-adapter/`):

- `src/index.ts` — spawns the stdio server (`McpServer name: workjournal`).
- `src/tools/register.ts` — all 7 tool definitions (single canonical profile).
- `src/tools/core-tools.ts` — the 7 merged agent workflow tools.
- `src/tools/query.ts` — GET query-string builder (omits absent filters).
- `src/client.ts` — loopback HTTP forwarder with actionable down-service error.
- `workjournal-mcp.cmd` — Windows launcher for the adapter.

**Client config (example — Claude Code / Cline style MCP settings):**

```json
{
  "mcpServers": {
    "workjournal": {
      "command": "node",
      "args": ["C:/path/to/PERSONAL_workJournal/backend/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs", "C:/path/to/PERSONAL_workJournal/backend/packages/mcp-adapter/src/index.ts"],
      "env": { "WORKJOURNAL_CORE_URL": "http://127.0.0.1:3737" }
    }
  }
}
```

(Prefer the repo's `workjournal-mcp.cmd` on Windows, or `pnpm --filter
@workjournal/mcp-adapter start`. Rebuild with `pnpm build` for a `dist/`
entry instead of `tsx`.)

## 4. Tool catalog (what an agent can do)

One canonical tool set — no profiles, no `WORKJOURNAL_TOOLS` env var, no
duplicated names or schemas. Every tool auto-resolves `project_id` from the
discovered project marker (or `WORKJOURNAL_PROJECT_ID`), derives its own
idempotency key for writes, and tracks the current task in session state so
agents rarely pass `agent_id`, `idempotency_key`, or `task_id`.

| # | Tool | What it does |
|---|------|--------------|
| 1 | `start_session` | Begin or resume work. Returns your in_progress tasks, a resume brief for `task_id`, and project stats. With `task_id` + `claim=true`, claims ownership. |
| 2 | `create_task` | Create a task (title, objective, acceptance, priority). Becomes the current task. Idempotency key auto-derived. |
| 3 | `update_task` | **Single tool for all status changes** — `in_progress` (claim), `open` (release/unblock), `blocked`, `interrupted`, `completed`, `cancelled` — plus field edits (title/objective/acceptance/priority). Replaces the old split tools (`claim_task`, `block_task`, `complete_task`, etc.). |
| 4 | `checkpoint` | Record a progress checkpoint (summary, next_steps, done, findings, issues, files). Call after each meaningful step. |
| 5 | `record_decision` | Record a design decision. Pass `supersedes=<decision id>` to replace an earlier decision (keeps the old record marked superseded). |
| 6 | `get_resume_context` | Deterministic resume brief: objective, status, latest checkpoint, active decisions, open issues, recent events. Pass `include_history=true` to append recent event history. |
| 7 | `list_tasks` | Browse tasks with `status`/`priority`/`limit` filters. Defaults to actionable tasks (open, interrupted, in_progress). Pass `task_id` to fetch a single task (replaces `get_task`). |

**Contracts every write obeys:** an idempotency key (auto-derived; retry-safe;
conflicting reuse → `409 IDEMPOTENCY_KEY_CONFLICT`), the owner's `agent_id`
(`<agent-string>_<project-id>`), and the `expected_version` last read (stale →
`409 STALE_VERSION`). Reads need no key. Full shapes live in
`backend/packages/shared/src/schemas/` — the single definition shared by API,
adapter, and dashboard.

**Dropped from MCP:** `get_task`, `get_task_history`, `get_dashboard`,
`export_handoff`, `claim_task`, `release_task`, `block_task`, `unblock_task`,
`complete_task`, `cancel_task`, `mark_task_interrupted`, `supersede_decision`,
`record_checkpoint`, and all `report_*` telemetry tools. Their functions are
absorbed into the 7 tools above or exposed via the HTTP API/dashboard instead.

## 4.5 Resource catalog (read-only, cache-friendly)

Resources are read-only views over data agents already access via tools.
MCP clients can cache them, so repeated reads don't hit the core service.
No idempotency key, agent_id, or project_id needed — the adapter resolves
those from session state.

| # | URI | What it returns |
|---|-----|-----------------|
| 1 | `workjournal://session/current` | Session state: current task id, version, agent id, project id. No core call — reads from adapter session memory. |
| 2 | `workjournal://tasks/current` | Full details of the current task (reads current task id from session state, then one core GET). |
| 3 | `workjournal://resume/{task_id}` | Deterministic resume context: objective, status, latest checkpoint, active decisions, open issues, recent events. One core GET /api/resume. |
| 4 | `workjournal://tasks/list` | Actionable tasks + count summary (open, in_progress, interrupted) for the current project. One core GET /api/tasks + counts. |
| 5 | `workjournal://tasks/{task_id}` | Fetch a single task by ID. One core GET /api/tasks/:id. |
| 6 | `workjournal://history/{task_id}` | Append-only event history for a task (creation, claims, transitions, checkpoints, decisions). One core GET /api/events. |

**When to use a resource vs a tool:** Use resources for read-only lookups
(resume context, task details, history, session state). Use tools for
anything that mutates state (create, claim, transition, checkpoint, decision).
Resources never mutate state.

## 5. A typical agent session (happy path)

1. Read `workjournal://session/current` → see your current task (if any).
   Or call `start_session` → see what's active, project stats, in-progress tasks.
2. Read `workjournal://resume/{task_id}` → deterministic brief (never trust
   remembered state). Or call `get_resume_context { task_id }`.
3. Call `start_session(task_id, claim=true)` → claim an open/interrupted task
   (ownership assigned).
4. Work; `checkpoint` often (pin to the version read).
5. `record_decision` for real choices (+ rationale + rejected alternatives).
6. `update_task(status="completed")` (or `update_task(status="blocked", reason="…")` /
   `update_task(status="interrupted", reason="…")` if the attempt ends).
7. Next session starts at step 1–2 — no transcript required.

## 6. Reviewer spot-checks

- Kill the core → agent tool call should return the actionable "start it"
  error, not a hang or a stack trace.
- Replay any write with the same key + identical input → same stored response,
  no duplicate. Same key + different input → `409`.
- `get_resume_context` twice on unchanged records → byte-identical brief.
