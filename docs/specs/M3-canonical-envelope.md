# Spec — M3: Canonical event envelope (post-MVP unified event model)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §2 intro (D-023), §3 (WS-2), §5.3
Source of truth: this spec captures plan §3 verbatim where quoted; it introduces no code, no schemas, and no new APIs beyond those named in the plan.

## 1. Purpose

Pin the canonical event envelope and the WS-2 event-model extensions as a reviewable spec before any schema or service code is written (repo rule: spec before implementation). WS-2 implements `packages/core/src/domain/event-service.ts` extensions and `shared/src/types/events.ts` additions against this contract.

## 2. Canonical envelope

Every event persisted by Core — task lifecycle or agent ledger — is stored and exchanged as one canonical envelope. Field table:

| Field | Type | Notes |
|---|---|---|
| `event_id` | text | Client-generated id; idempotency/dedup key for ingestion |
| `occurred_at` | text (UTC) | Event occurrence timestamp; all timestamps stored in UTC |
| `source` | text | `core` \| `mcp_tool` \| `agent:<agent-id>` — who/what produced the event |
| `category` | text | `task` \| `agent` \| `progress` \| `decision` \| `verification` \| `recovery` (default `task` for existing rows) |
| `type` | text | One of the event types in §3 |
| `project_id` | text | Owning project |
| `task_id` | text, NULLABLE | NULL for project-level agent lifecycle events; see §3.1 |
| `actor` | text | Actor making the record (agent id or `operator`) |
| `payload` | json | Per-type payload, validated by strict Zod schema before insert |
| `sequence` | integer | Per-task (or per-project for NULL task_id) monotonic sequence |

Existing `events` rows keep `category = 'task'`, `source = 'core'`; migration `002_unified_events.sql` adds `category` and `source` (project DB) plus index `(project_id, task_id, sequence)` supporting both query shapes (§3.1, §3.2).

### Constraint — agent events never set status

No agent event payload schema allows setting `task.status` or otherwise mutating task state. The single domain-level transition function (`core/src/domain/transitions.ts`, backend AGENTS.md invariant #2) remains the only code path that changes task status; ingestion is ledger-only (§2/D-023, §9.1 of this spec's sibling M10).

## 3. Categories and event types (plan §3.2)

| Category | Types (* = new) | Notes |
|---|---|---|
| task | `task_created`, `task_updated`, `task_claimed`, `task_released`, `task_transitioned` | existing |
| agent | `agent_session_started*`, `agent_session_ended*`, `agent_interrupted*`, `agent_timed_out*` | only where reliably observable |
| progress | `progress_milestone*`, `progress_fulfilment*` | fulfilment triggers checkpoint *evaluation* (§5) |
| decision | `decision_recorded`, `decision_superseded` | existing |
| verification | `verification_passed*`, `verification_failed*`, `verification_skipped*` | |
| recovery | `checkpoint_recorded` (existing), `recovery_started*`, `recovery_completed*` | |

## 4. Payload schemas (plan §3.3)

Every new type gets a strict Zod payload schema in `shared/src/types/events.ts`. Agent events carry `agent_id`, `session_id` where applicable, and bounded free-text fields (`summary`, `findings`, `blockers`, `next_steps`, `files_changed`). Verification events carry `check_type` and outcome detail.

## 5. EventService extensions (plan §3.4)

- `recordAgentEvent`, `recordProgressEvent`, `recordVerificationEvent`, `recordRecoveryEvent` — all funnel through one internal `append()` that enforces sequence assignment, payload validation, idempotency, and per-task/project scope.
- Idempotent ingestion: an agent may resend an event with the same idempotency key; duplicate content sent with a new key is stored (append-only) but flagged in its payload hash for policy dedup (§5.3 of this doc's sibling M5; plan §5.3).

## 6. New MCP tools (plan §3.5)

| Tool | Purpose |
|---|---|
| `start_agent_session` / `end_agent_session` | record agent lifecycle |
| `report_interruption` / `report_timeout` | record interruption/timeout |
| `report_progress_milestone` | record a milestone |
| `report_fulfilment` | record fulfilment AND trigger checkpoint evaluation |
| `report_verification` | record pass/fail/skip |
| `evaluate_checkpoint` | run policy; create checkpoint only if warranted |

All require idempotency key + `agent_id`; none performs an authoritative task status transition.

## 7. Coordination notes (no invention)

Plan §10.11 names `agent_idle` as a WS-5 checkpoint-evaluation trigger signal and §3.1's nullable `task_id` as required for project-level plugin events. Those are WS-2/WS-5 concerns; this spec records them only as cross-references and does not add them to the type table above.

## 8. Verification (docs-only)

- Every field, category, type, and rule above traces to plan §2–§3; nothing added that the plan does not name.
- git diff for this session contains `docs/specs/*` only.