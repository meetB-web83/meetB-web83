# Spec — M9: Change notifications + change records (post-MVP)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §9 (WS-8), §10.11
Source of truth: this spec captures plan §9.1–§9.4 verbatim where quoted; docs-only, no code.

## 1. Purpose

Pin the change-record shape and the Core/adapter notification contract so WS-8 implements post-commit change streaming against a single reviewable reference, decoupled from the dashboard.

## 2. Core side (plan §9.1)

After each **successful commit**, services append an internal change record:

```text
{ resource_type, resource_id, project_id?, task_id?, change, occurred_at }
```

Core exposes:

- `GET /api/changes/stream` — SSE stream of change records.
- `GET /api/changes?since=` — bounded long-poll fallback.

No notification is emitted **before** commit — failed writes produce nothing. Dashboard/dashboard polling remains a separate concern (§9.3).

## 3. Adapter side (plan §9.2)

- One Core change subscription per adapter process.
- Fan-out to each connected MCP session.
- Reconnection: exponential backoff; on reconnect the adapter does an authoritative refetch (prompts re-sync; resources are stateless, so nothing to replay).
- Missed notifications are tolerated by design — clients refetch.

## 4. Dashboard side (plan §9.3)

Separate lightweight polling (existing pattern) or a dedicated SSE endpoint later; the dashboard is **not coupled** to MCP notifications.

## 5. Alternative — documented, not chosen (plan §9.4)

A single-process merge of MCP into Core would remove the bridge and allow in-process emitters, at the cost of coupling stdio MCP lifecycle to the long-running service, changing `mcp --with-ui` semantics, complicating SEA packaging, and breaking the "adapter never touches SQLite" isolation. Deferred unless the bridge proves unreliable in practice.

## 6. Verification (docs-only)

- Change-record shape, the two endpoints, SSE + long-poll, and "post-commit only" trace to plan §9.1.
- Adapter fan-out/backoff/reconnect behavior traces to §9.2; dashboard decoupling to §9.3; the single-process alternative to §9.4.
- `GET /api/changes/stream` and `GET /api/changes?since=` are named exactly as in the plan; no endpoints invented.
- git diff for this session contains `docs/specs/*` only.