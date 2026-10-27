# Spec — M10: Event ingestion API (post-MVP)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §2 (D-023), §10.5 (WS-9 plugin→Core), §10.11
Source of truth: this spec captures plan §2/D-023 and §10.5 verbatim where quoted; docs-only, no code.

## 1. Purpose

Pin the `POST /api/ingest/events` contract so WS-2 (nullable `task_id`, envelope schema) and WS-9 (OpenCode lifecycle plugin delivery) implement one shared, reviewable interface. The plugin translates native agent events into this canonical envelope; Core never lets ingestion mutate task status.

## 2. Endpoint contract (plan §2/D-023)

`POST /api/ingest/events` accepts a **bounded batch of canonical envelopes** (see M3) restricted to **ledger categories only**: `agent`, `progress`, `verification`, `recovery` signals.

- **Batch bound:** ≤ 50 envelopes per request.
- **Restriction:** task-lifecycle or transition-shaped payloads are rejected with `400`. The single transition function remains the only path that changes task status (backend AGENTS.md invariant #2).
- **Idempotency:** by client-generated `event_id` — retry-safe dedup; resending an accepted `event_id` is a no-op.
- **Per-event response:** each envelope in the batch reports one of `accepted` \| `duplicate` \| `rejected`, so a partial batch never silently drops events.

## 3. Session → task binding (plan §2/D-023)

The MCP adapter forwards OpenCode's `ai.opencode/sessionID` tool-call `_meta` to Core. Core maintains a session↔task binding, established on successful claim-like tools, so later plugin events for the same session are backfilled with `task_id`. Events with no binding remain project-level (`task_id` NULL per plan §3.1/M3).

## 4. Plugin → Core behavior (plan §10.5 / §10.11)

- The OpenCode lifecycle plugin POSTs canonical envelopes to `POST /api/ingest/events`.
- Delivery uses a bounded queue in `ctx.storage` with backoff when Core is down; the plugin never autostarts Core (the MCP adapter's D-013 autostart covers agent work sessions).
- Envelopes are restricted to ledger categories — they cannot mutate task state even if the endpoint is abused (loopback-only posture: Zod validation + payload limits, same as all Core routes).
- Ingestion envelopes reuse the canonical schema (M3); nullable `task_id` (§3.1) is required for project-level plugin events (plan §10.11).

## 5. Verification (docs-only)

- Endpoint, batch bound (≤50), ledger-only restriction, `event_id` dedup, and per-event `accepted`/`duplicate`/`rejected` responses all trace to plan §2/D-023 and §10.5.
- No task-status mutation through ingestion: consistent with M3 §2 and plan §2/D-023.
- git diff for this session contains `docs/specs/*` only.