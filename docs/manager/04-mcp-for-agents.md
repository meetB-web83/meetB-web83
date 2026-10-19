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
- `src/tools/register.ts` — all ~19 tool definitions.
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

| Group | Tools |
|-------|-------|
| Tasks | `create_task`, `get_task`, `list_tasks` (status/priority/limit/offset), `update_task` |
| Claims & transitions | `claim_task`, `release_task`, `block_task`, `unblock_task`, `complete_task`, `cancel_task`, `mark_task_interrupted` |
| Continuity | `record_checkpoint`, `record_decision`, `supersede_decision` |
| Read-back | `get_task_history`, `get_resume_context`, `export_handoff` (json/markdown) |
| Overview | `get_dashboard` (stats + recents + project list; `project_id` optional scope) |

**Contracts every write obeys:** an `idempotency_key` (retry-safe; conflicting
reuse → `409 IDEMPOTENCY_KEY_CONFLICT`), the owner's `agent_id`
(`<agent-string>_<project-id>`), and the `expected_version` last read (stale →
`409 STALE_VERSION`). Reads need no key. Full shapes live in
`backend/packages/shared/src/schemas/` — the single definition shared by API,
adapter, and dashboard.

## 5. A typical agent session (happy path)

1. `get_dashboard` → see what's active. 2. `get_resume_context { task_id }` →
   deterministic brief (never trust remembered state). 3. `claim_task` (open →
   in_progress, ownership assigned). 4. Work; `record_checkpoint` often (pin to
   the version read). 5. `record_decision` for real choices (+ rationale +
   rejected alternatives). 6. `complete_task` (or `block_task` with reason /
   `mark_task_interrupted` if the attempt ends). 7. Next session starts at step
   1–2 — no transcript required.

## 6. Reviewer spot-checks

- Kill the core → agent tool call should return the actionable "start it"
  error, not a hang or a stack trace.
- Replay any write with the same key + identical input → same stored response,
  no duplicate. Same key + different input → `409`.
- `get_resume_context` twice on unchanged records → byte-identical brief.
