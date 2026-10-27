# Spec — M7: workjournal:// MCP resources (post-MVP)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §7 (WS-6), §10.11
Source of truth: this spec captures plan §7.1–§7.3 verbatim where quoted; docs-only, no code.

## 1. Purpose

Pin the `workjournal://` URI scheme and its 9 resource templates so WS-6 registers them against a single reviewable reference. Resources expose Core data to capable MCP clients without duplicating business logic.

## 2. URI scheme & templates (plan §7.1)

| URI template | Core endpoint (source) |
|---|---|
| `workjournal://projects` | `GET /api/dashboard` |
| `workjournal://projects/{project_id}` | `GET /api/dashboard?project_id` |
| `workjournal://projects/{project_id}/tasks` | `GET /api/tasks?project_id` |
| `workjournal://projects/{project_id}/tasks/{task_id}` | `GET /api/tasks/{task_id}` |
| `workjournal://projects/{project_id}/tasks/{task_id}/resume` | `GET /api/resume?task_id` |
| `workjournal://projects/{project_id}/tasks/{task_id}/history` | `GET /api/events?task_id` |
| `workjournal://projects/{project_id}/tasks/{task_id}/checkpoints` | `GET /api/checkpoints?task_id` |
| `workjournal://projects/{project_id}/tasks/{task_id}/checkpoints/{checkpoint_id}` | `GET /api/checkpoints/{checkpoint_id}` |
| `workjournal://projects/{project_id}/tasks/{task_id}/decisions` | `GET /api/decisions?task_id` |

Registered in `packages/mcp-adapter/src/server-factory.ts` via `registerResource` / `registerResourceTemplate`, with completions for `project_id` and `task_id`.

All resource handlers are **read-only, bounded, and call Core APIs** — no duplicate business logic, no checkpoint creation on read.

## 3. Invalidation & notifications (plan §7.2)

Core emits post-commit change records (see M9); the adapter maps them to affected URIs and sends `sendResourceUpdated({uri})` per subscribed session. `sendResourceListChanged()` fires only when the resource *list* changes (rare). Reads never mutate; clients that miss notifications refetch authoritatively (stateless design, no replay).

## 4. Client access (plan §7.3)

Resources are discoverable by capable clients via `resources/list`; agents that ignore resources retain every existing tool as fallback. Documented in the CLI/README.

## 5. Verification (docs-only)

- All 9 templates and their Core endpoints trace to plan §7.1; read-only/completions/notifications behavior traces to §7.2–§7.3.
- Registration file (`packages/mcp-adapter/src/server-factory.ts`) is an existing architecture fact cited from the plan's WS-1 context; no new file paths invented.
- git diff for this session contains `docs/specs/*` only.