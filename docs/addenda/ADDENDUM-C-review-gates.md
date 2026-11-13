# Addendum C — Review Gates: Human-in-the-Loop Task Lifecycle

**Status:** proposed (no implementation begun)  
**Date:** 2026-11-13  
**Author:** agent (this session)  
**Source of truth precedence:** root AGENTS.md "Decisions overriding the scope doc" > this addendum > `docs/WorkJournal_MVP.md` > `docs/specs/shared-contracts.md` > `docs/specs/A-B-working-tree-rollback.md`  
**Deviations from existing docs:** called out explicitly in §1.3.

---

## 1. Understanding, Conflicts, and Ambiguities

### 1.1 Goal (in my words)
WorkJournal currently lets an agent create → claim → complete a task with zero human involvement. The company's AI Development Playbook requires **two human gates**:
1. **Before work starts:** a human reviews and approves the task (objective, acceptance criteria, non-goals) → task becomes claimable (`open`).
2. **Before work counts as done:** the agent submits evidence; a human verifies (runs locally, checks diff, runs tests, confirms no unrelated changes/dependencies) → task becomes `completed`.

This addendum introduces `draft` and `review` statuses, a `non_goals` field on tasks, a **review submission** record (agent-authored at submit time), a **verification** record (human-authored at verify time), and the necessary transitions, events, MCP/API/dashboard surfaces, and export changes. All human-only operations are exposed via the dashboard/API only; the MCP adapter rejects them and the reserved `operator` actor.

### 1.2 Conflicts with existing scope and addenda

| Existing rule | Conflict | Resolution in this addendum |
|---------------|----------|----------------------------|
| MVP §5: statuses are `open`, `in_progress`, `blocked`, `interrupted`, `completed`, `cancelled` | New statuses `draft` and `review` required | Add them; update transition table, event types, and all consumers |
| MVP §5: `in_progress → completed` is allowed | Proposed: remove direct `in_progress → completed`; replace `complete_task` with `submit_for_review` | Remove the transition; add `in_progress → review` (agent) and `review → completed` (human only) |
| MVP §5: `complete_task` MCP tool exists | Proposed: remove `complete_task`, add `submit_for_review` | MCP tool renamed; adapter rejects `operator` for this tool |
| MVP §7: checkpoints capture progress | Proposed: review submission includes a task-level snapshot (Addendum A) | Reuse Addendum A snapshot machinery; `submit_for_review` captures a `review` kind snapshot |
| MVP §10: resume context sections are fixed | Proposed: feedback note from `request_changes` appears in resume context | Add a "Review feedback" section after checkpoint, before decisions |
| MVP §12: dashboard shows task detail, lists | Proposed: draft approval queue, review screen with diff/evidence/checklist | New dashboard pages/components; existing lists filter by new statuses |
| MVP §13/14: JSON and HANDOFF.md exports | Proposed: include review submission, verification, snapshot diff | Export schema version bump; new fields |
| Shared contracts §1: `updateTaskSchema` allows agent edits to objective/acceptance | Proposed: criteria locking — after approval, only humans edit objective, acceptance, non_goals | Add `criteria_locked` boolean on task; enforce in transition function and update schema |
| Shared contracts §6: idempotency key on every write | Proposed: same rules apply; human actions use `operator` actor | No change to idempotency mechanics; `operator` is a valid actor |
| Addendum A/B: snapshots have kinds `baseline`, `checkpoint`, `safety`, `rollback` | Proposed: add `review` kind for submit-time snapshot | Extend snapshot `kind` CHECK constraint; migration required |
| Addendum B: rollback can target any snapshot | Proposed: `request_changes` may optionally trigger rollback to a checkpoint | Reuse `revert_task_changes` flow; `request_changes` records a `review_feedback` event with optional `rollback_target_checkpoint_id` |

### 1.3 Ambiguities to resolve (open questions for meetb)

1. **Q1:** When a human creates a task via the dashboard, does it start as `draft` (requiring self-approval) or `open`? The proposal says "Human-created tasks may start as `open`." — confirm this is the desired UX.
2. **Q2:** The `non_goals` field: free-text array? Markdown? Structured? Proposed: `string[]` (Zod `z.array(z.string().max(500)).max(20)`).
3. **Q3:** Review submission evidence per acceptance criterion: proposed schema is `{ criterion_index: number, met: boolean, how_checked: string }`. Is `how_checked` free text or an enum (tested | inspected | manual | other)?
4. **Q4:** Reviewer checklist: the proposal lists 4 items. Are these fixed, or configurable per project? Proposed: fixed in R1; stored as JSON boolean flags on the verification record.
5. **Q5:** `request_changes` optional rollback: does the human choose the target checkpoint, or is it always "latest checkpoint"? Proposed: human selects from the task's non-rolled-back checkpoints (default = latest).
6. **Q6:** Criteria locking: when exactly does it engage? Proposed: on the `draft → open` approval transition. Once locked, agents can only `block_task` with a reason if they find the task wrong.
7. **Q7:** The `operator` actor is reserved for dashboard actions. The MCP adapter must reject `operator` for all tools. Confirm this is the only guardrail (R1 has no auth).
8. **Q8:** Migration strategy for existing tasks: all current tasks are `open`/`in_progress`/etc. Do they get `criteria_locked = true` (grandfathered as already approved) or `false`? Proposed: `true` for existing tasks (they bypass the draft gate).
8. **Q9:** Resume context size limit: the new "Review feedback" section must be preserved under truncation (like decisions). Confirm priority.
9. **Q10:** Export schema version: bump to v3? Addendum B bumped to v2. This addendum should be v3.

> **Assumptions** (marked throughout): A1–A10 correspond to the proposed answers above. If meetb disagrees, the document will be updated.

---

## 2. Full Transition Table

### 2.1 Statuses (new set)
```
draft → open → in_progress → review → completed
                ↓           ↓
              blocked      (request_changes) → in_progress
                ↓
              interrupted → in_progress | open | cancelled
                ↓
              cancelled (terminal)
```
`review` is terminal for agents; only human `verify` moves it to `completed`. `request_changes` moves `review → in_progress`.

### 2.2 Transition table (from, to, allowed actor, required fields, idempotency key always required)

| From | To | Actor | Required fields | Tool / API | Notes |
|------|-----|-------|-----------------|------------|-------|
| `draft` | `open` | `operator` (human) | `idempotency_key`, optional `approval_note` | `approve_task` (dashboard/API only) | Sets `criteria_locked = true`; captures baseline snapshot if not exists |
| `draft` | `cancelled` | `operator` | `idempotency_key`, `reason` | `cancel_task` (dashboard/API) | Terminal |
| `open` | `in_progress` | agent (owner) | `idempotency_key` | `claim_task` | Existing; owner must be NULL |
| `open` | `cancelled` | `operator` or owner | `idempotency_key`, `reason` | `cancel_task` | |
| `in_progress` | `open` | owner | `idempotency_key` | `release_task` | Existing |
| `in_progress` | `blocked` | owner | `idempotency_key`, `reason` | `block_task` | Existing |
| `in_progress` | `interrupted` | owner | `idempotency_key`, `reason` | `mark_task_interrupted` | Existing |
| `in_progress` | `cancelled` | owner or `operator` | `idempotency_key`, `reason` | `cancel_task` | Existing |
| `in_progress` | `review` | owner | `idempotency_key`, `review_submission` (see §3.3) | `submit_for_review` | **New**; replaces `complete_task`; captures `review` snapshot |
| `blocked` | `open` | owner or `operator` | `idempotency_key`, `resolution_note` | `unblock_task` | Existing |
| `blocked` | `cancelled` | owner or `operator` | `idempotency_key`, `reason` | `cancel_task` | Existing |
| `interrupted` | `in_progress` | agent (recovering) | `idempotency_key` | `claim_task` | Existing recovery path |
| `interrupted` | `open` | `operator` | `idempotency_key` | `release_task` (operator) | Operator recovery |
| `interrupted` | `cancelled` | `operator` | `idempotency_key`, `reason` | `cancel_task` | |
| `review` | `completed` | `operator` (human) | `idempotency_key`, `verification` (see §3.4) | `verify_task` (dashboard/API only) | **New**; human-only |
| `review` | `in_progress` | `operator` (human) | `idempotency_key`, `feedback_note`, optional `rollback_target_checkpoint_id` | `request_changes` (dashboard/API only) | **New**; human-only; may trigger rollback |

**Removed transition:** `in_progress → completed` (was via `complete_task`).

**Actor rules:**
- `operator` is valid for all human-only transitions (`draft→open`, `review→completed`, `review→in_progress`, and operator recovery/cancel/unblock).
- Agents (non-`operator`) may never invoke `approve_task`, `verify_task`, `request_changes`.
- The MCP adapter **must reject** any tool call with `agent_id === 'operator'` (see §4).

### 2.3 Single domain-level transition function changes

File: `packages/core/src/domain/transitions.ts` (or equivalent).

Current function signature (conceptual):
```ts
transitionTask(taskId, targetStatus, actor, input, idempotencyKey) → { task, event }
```

Changes:
1. Add `draft` and `review` to the status enum and `TRANSITIONS` map.
2. Remove `in_progress → completed` from `TRANSITIONS`.
3. Add `in_progress → review` (agent), `review → completed` (operator), `review → in_progress` (operator), `draft → open` (operator).
4. New validation branches:
   - `draft → open`: require `actor === 'operator'`; set `criteria_locked = true` on task; if no baseline snapshot exists, capture one (Addendum A `capture_baseline`).
   - `in_progress → review`: require `actor === task.owner`; validate `review_submission` payload (Zod); capture `review` kind snapshot (Addendum A); create `review_submission` record; emit `task_transitioned` + `review_submitted` events.
   - `review → completed`: require `actor === 'operator'`; validate `verification` payload; create `verification` record; emit `task_transitioned` + `task_verified` events.
   - `review → in_progress`: require `actor === 'operator'`; validate `feedback_note`; create `review_feedback` event with `feedback_note` and optional `rollback_target_checkpoint_id`; if rollback target provided, invoke rollback engine (Addendum B) inside the same transaction? **No** — rollback is a separate filesystem mutation; do it *after* the transition commits, but record the intent in the event. The rollback itself creates its own `revert_applied` event. The `request_changes` transition only records the feedback and the *intent* to rollback.
5. Criteria locking enforcement: in `updateTask` (and any mutation of `objective`, `acceptance_criteria`, `non_goals`), if `task.criteria_locked && actor !== 'operator'` → reject with `CRITERIA_LOCKED` (new error code, 403).
6. Version checks: per D-004, task version was removed. The transition function uses ownership + idempotency only. No `expected_version` needed.
7. All transitions still write the state change + event(s) in a single `IdempotencyService.run` transaction.

### 2.4 New error codes (extend `packages/shared/src/errors.ts`)

| Code | HTTP | When |
|------|------|------|
| `CRITERIA_LOCKED` | 403 | Agent attempts to edit locked fields |
| `HUMAN_ONLY_ACTION` | 403 | Non-`operator` actor calls `approve_task`, `verify_task`, `request_changes` |
| `INVALID_REVIEW_SUBMISSION` | 422 | `review_submission` payload fails Zod |
| `INVALID_VERIFICATION` | 422 | `verification` payload fails Zod |
| `INVALID_FEEDBACK` | 422 | `feedback_note` missing or too long |
| `TASK_NOT_IN_REVIEW` | 422 | `verify_task`/`request_changes` on non-`review` task |
| `TASK_NOT_IN_DRAFT` | 422 | `approve_task` on non-`draft` task |

---

## 3. Data Model Changes

### 3.1 Tasks table (project DB)

Migration: `005_review_gates.sql` (appended, never edited).

```sql
-- New columns on tasks
ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'draft' 
  CHECK (status IN ('draft','open','in_progress','blocked','interrupted','review','completed','cancelled'));
-- Note: existing rows have status from old CHECK; this migration must rebuild the table or use a two-step
-- SQLite approach: create new table, copy, drop, rename. Since status CHECK cannot be altered in place,
-- we follow the Addendum A pattern: rebuild tasks table.

ALTER TABLE tasks ADD COLUMN non_goals TEXT NOT NULL DEFAULT '[]'; -- JSON array of strings
ALTER TABLE tasks ADD COLUMN criteria_locked INTEGER NOT NULL DEFAULT 0; -- 0/1 boolean
ALTER TABLE tasks ADD COLUMN baseline_snapshot_id TEXT; -- nullable, FK to task_snapshots(id)
ALTER TABLE tasks ADD COLUMN review_snapshot_id TEXT;   -- nullable, FK to task_snapshots(id)
```

**Migration strategy:** SQLite cannot alter a CHECK constraint. Rebuild `tasks` table (like Addendum A did for `task_snapshots`). Copy all columns, map old statuses to new (no change), set `criteria_locked = 1` for all existing tasks (grandfathered, assumption A8), `non_goals = '[]'`, snapshot IDs NULL.

### 3.2 Snapshots table (Addendum A) — extend `kind` CHECK

```sql
-- Rebuild task_snapshots (same pattern as Addendum A migration 004)
-- New kind: 'review'
-- kind CHECK IN ('baseline','checkpoint','safety','rollback','review')
```

### 3.3 Review submission table (new)

```sql
CREATE TABLE review_submissions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL, -- the submitting agent
  summary TEXT NOT NULL,  -- agent's summary of work done
  evidence TEXT NOT NULL, -- JSON: [{ criterion_index, met, how_checked }]
  tests_run TEXT NOT NULL, -- JSON: [{ name, passed, output? }]
  known_gaps TEXT NOT NULL, -- JSON: string[]
  snapshot_id TEXT NOT NULL REFERENCES task_snapshots(id), -- the 'review' snapshot
  created_at TEXT NOT NULL, -- UTC ISO
  event_id TEXT NOT NULL REFERENCES events(id) -- the review_submitted event
);
CREATE INDEX idx_review_submissions_task ON review_submissions(task_id);
```

### 3.4 Verification record table (new)

```sql
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_actor TEXT NOT NULL DEFAULT 'operator', -- always 'operator' in R1
  checklist TEXT NOT NULL, -- JSON: { read_diff, ran_locally, tested_feature, no_unrelated_changes, no_new_deps }
  notes TEXT, -- optional human notes
  created_at TEXT NOT NULL, -- UTC ISO
  event_id TEXT NOT NULL REFERENCES events(id) -- the task_verified event
);
CREATE INDEX idx_verifications_task ON verifications(task_id);
```

### 3.5 New event types and payload schemas (extend `packages/shared/src/types/events.ts`)

```ts
// New event types
'task_transitioned', // existing, payload gains new statuses
'review_submitted',  // new
'task_verified',     // new
'review_feedback',   // new (request_changes)

// Payloads (all .strict())
review_submitted: {
  task_id: string,
  agent_id: string,
  review_submission_id: string,
  snapshot_id: string,
  summary: string,
  evidence: { criterion_index: number, met: boolean, how_checked: string }[],
  tests_run: { name: string, passed: boolean, output?: string }[],
  known_gaps: string[],
}
task_verified: {
  task_id: string,
  reviewer_actor: string, // 'operator'
  verification_id: string,
  checklist: { read_diff: boolean, ran_locally: boolean, tested_feature: boolean, no_unrelated_changes: boolean, no_new_deps: boolean },
  notes?: string,
}
review_feedback: {
  task_id: string,
  reviewer_actor: string, // 'operator'
  feedback_note: string,
  rollback_target_checkpoint_id?: string, // if human requested rollback
}
```

Add to `EVENT_TYPES` array.

### 3.6 Event emission policy

- `review_submitted`: emitted inside the `in_progress → review` transition transaction (after snapshot capture).
- `task_verified`: emitted inside the `review → completed` transition transaction.
- `review_feedback`: emitted inside the `review → in_progress` transition transaction.
- All follow append-only, per-task monotonic sequence.

### 3.7 Registry DB: no changes (review gates are per-project).

---

## 4. MCP Changes

### 4.1 Tools removed
- `complete_task` — removed entirely.

### 4.2 Tools added (agent-facing)
- `submit_for_review` — input: `task_id`, `agent_id`, `review_submission` (Zod), `idempotency_key`. Forwards to `POST /api/tasks/:id/submit-for-review`.

### 4.3 Tools NOT added (human-only, dashboard/API only)
- `approve_task` (draft → open)
- `verify_task` (review → completed)
- `request_changes` (review → in_progress)

### 4.4 Adapter enforcement
- In `registerTools()`: do not register the three human-only tools.
- In the tool handler wrapper (or a shared guard): if `agent_id === 'operator'` → throw `HUMAN_ONLY_ACTION` with message: `"This action is only available through the dashboard. The 'operator' actor is reserved for human review actions."`
- The `submit_for_review` tool validates `agent_id !== 'operator'` (agents cannot be `operator`).

### 4.5 Actionable error codes for rejected human-only actions
- `HUMAN_ONLY_ACTION` (403) — returned by MCP adapter before forwarding.
- Dashboard/API returns the same code for non-`operator` callers (defense in depth).

---

## 5. API and Dashboard Changes

### 5.1 Core HTTP routes (new, under `/api/tasks`)

| Route | Method | Schema | Actor | Notes |
|-------|--------|--------|-------|-------|
| `/:id/approve` | POST | `approveTaskSchema` | `operator` | draft → open |
| `/:id/submit-for-review` | POST | `submitForReviewSchema` | owner (agent) | in_progress → review |
| `/:id/verify` | POST | `verifyTaskSchema` | `operator` | review → completed |
| `/:id/request-changes` | POST | `requestChangesSchema` | `operator` | review → in_progress |

All require `idempotency_key` in body. Routes validate, then call domain transition service.

### 5.2 Shared Zod schemas (new, `packages/shared/src/schemas/task.ts`)

```ts
export const approveTaskSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  approval_note: z.string().max(2000).optional(),
});

export const submitForReviewSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  review_submission: z.object({
    summary: z.string().min(1).max(5000),
    evidence: z.array(z.object({
      criterion_index: z.number().int().nonnegative(),
      met: z.boolean(),
      how_checked: z.string().min(1).max(2000),
    })).min(1),
    tests_run: z.array(z.object({
      name: z.string().min(1).max(200),
      passed: z.boolean(),
      output: z.string().max(5000).optional(),
    })),
    known_gaps: z.array(z.string().max(500)).max(50),
  }),
});

export const verifyTaskSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  verification: z.object({
    checklist: z.object({
      read_diff: z.boolean(),
      ran_locally: z.boolean(),
      tested_feature: z.boolean(),
      no_unrelated_changes: z.boolean(),
      no_new_deps: z.boolean(),
    }),
    notes: z.string().max(5000).optional(),
  }),
});

export const requestChangesSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  feedback_note: z.string().min(1).max(5000),
  rollback_target_checkpoint_id: z.string().optional(),
});
```

### 5.3 Dashboard changes

#### 5.3.1 New pages/components
- **Draft approval queue** (`/drafts` or filtered project task list): shows tasks with `status === 'draft'`. Each row: title, objective preview, "Approve" button → opens modal with full objective/acceptance/non_goals, approval_note input, confirm → calls `POST /api/tasks/:id/approve`.
- **Review screen** (`/review/:taskId`): accessible from task detail when `status === 'review'`. Shows:
  - **Diff panel**: computed by WorkJournal (not agent-provided) — `diff(baseline_snapshot, review_snapshot)` using Addendum A `get_task_changes` logic. Rendered as file list with statuses (added/modified/deleted), secret-filtered. No raw diff content in the UI (security).
  - **Evidence panel**: the `review_submission.evidence` array rendered as a table (criterion, met?, how_checked).
  - **Tests panel**: `tests_run` list with pass/fail badges.
  - **Known gaps**: bullet list.
  - **Reviewer checklist**: 5 checkboxes (read_diff, ran_locally, tested_feature, no_unrelated_changes, no_new_deps) — all required to enable "Verify" button.
  - **Notes**: optional text area.
  - **Actions**: "Verify" (calls `POST /api/tasks/:id/verify`), "Request changes" (opens modal with feedback_note + optional checkpoint selector for rollback → calls `POST /api/tasks/:id/request-changes`).

#### 5.3.2 Updated lists
- Project task list: add `draft` and `review` to status filter chips.
- Blocked/interrupted lists: unchanged.
- Dashboard stats (`GET /api/dashboard`): count `draft` and `review` tasks separately.

#### 5.3.3 Task detail page
- Show `criteria_locked` badge when true.
- Show `non_goals` section (read-only for agents, editable for `operator` in draft).
- When `status === 'review'`, show "View review" button linking to review screen.

#### 5.3.4 Task creation/edit modal
- Add `non_goals` field (array of strings, max 20 items, 500 chars each).
- When creating via dashboard: default status `open` (human-created tasks start claimable, per assumption A1). Agent-created tasks via MCP start as `draft`.

### 5.4 API response shapes
- `GET /api/tasks/:id` includes `criteria_locked`, `non_goals`, `baseline_snapshot_id`, `review_snapshot_id`.
- `GET /api/tasks/:id/review-submission` (new): returns the `review_submissions` row for the task's current review (if any).
- `GET /api/tasks/:id/verification` (new): returns the `verifications` row (if any).

---

## 6. Impact on Cross-Cutting Concerns

### 6.1 Idempotency
- All new transitions require `idempotency_key` (enforced by shared schemas).
- `operator` actor uses its own idempotency keys (dashboard generates them).
- Replay semantics unchanged: same key + operation + actor + input hash → stored response.
- Human actions are not retried by agents; dashboard can safely regenerate keys on retry.

### 6.2 Version checks
- Per D-004, task version column removed. No `expected_version` on any new operation.
- Concurrency safety via ownership + idempotency only.

### 6.3 Resume context ordering and determinism
`ResumeBuilder.build` (Addendum B §10) gains a new section:

**Order (stable, explicit ORDER BY):**
1. Task header (identity, objective, acceptance_criteria, **non_goals**, status, priority, version)
2. Latest checkpoint (working checkpoint per Addendum B — non-rolled-back)
3. **Review feedback** (new): if any `review_feedback` events exist, show the most recent one (by event sequence) with `feedback_note`, `reviewer_actor`, `created_at`, and whether a rollback was requested (and target checkpoint id). This section appears **after checkpoint, before decisions**.
4. Active decisions (chronological)
5. Completed work / current findings
6. Unresolved issues
7. Events since latest checkpoint (or all if none)

**Truncation priority (preserve order):** working checkpoint, review feedback, active decisions, unresolved issues, next steps, then older events. Explicit truncation note.

### 6.4 JSON export schema (handoff v3 — Addendum B was v2)

`packages/shared/src/schemas/handoff.ts` — bump `format_version: 3`.

New fields in `handoffJsonSchema`:
```ts
{
  // ... existing v2 fields
  non_goals: z.array(z.string()).default([]),
  criteria_locked: z.boolean(),
  review_submission: z.object({
    id: z.string(),
    summary: z.string(),
    evidence: z.array(z.object({ criterion_index: z.number(), met: z.boolean(), how_checked: z.string() })),
    tests_run: z.array(z.object({ name: z.string(), passed: z.boolean(), output: z.string().optional() })),
    known_gaps: z.array(z.string()),
    snapshot_id: z.string(),
    created_at: z.string(),
    agent_id: z.string(),
  }).nullable(),
  verification: z.object({
    id: z.string(),
    checklist: z.object({ read_diff: z.boolean(), ran_locally: z.boolean(), tested_feature: z.boolean(), no_unrelated_changes: z.boolean(), no_new_deps: z.boolean() }),
    notes: z.string().optional(),
    created_at: z.string(),
    reviewer_actor: z.string(),
  }).nullable(),
  review_feedback: z.array(z.object({
    feedback_note: z.string(),
    rollback_target_checkpoint_id: z.string().optional(),
    created_at: z.string(),
    reviewer_actor: z.string(),
  })).default([]),
}
```

Validation: `handoffJsonSchema.parse(export)` before returning/saving.

### 6.5 HANDOFF.md generation (v3)

New sections in Markdown output:
- `## Non-Goals` (bullet list from `non_goals`)
- `## Review Submission` (if present): summary, evidence table, tests, gaps, snapshot ref.
- `## Verification` (if present): checklist results, notes, reviewer, timestamp.
- `## Review Feedback` (if any): each feedback entry with note, rollback target, timestamp.

Must agree with JSON on all fields (test asserts agreement).

### 6.6 Secret filtering for diffs and submitted text
- **Diff panel (dashboard/API):** Uses Addendum A `get_task_changes` which already returns path-level summaries (no raw file content). The diff computation runs server-side; only path names and statuses are sent to the dashboard. Secret filtering applies to any file content that might be logged (it isn't).
- **Review submission fields:** `summary`, `evidence[].how_checked`, `tests_run[].output`, `known_gaps[]`, `feedback_note`, `verification.notes` — all are **agent/human-provided text**. Apply the existing secret filter (from `packages/shared/src/security/secret-filter.ts`) before storing in the database? **No** — the filter is applied at export/log time. Storing raw text is fine; the filter runs on:
  - JSON export (`handoffJsonSchema` transform or post-process)
  - HANDOFF.md generation
  - Pino logs (existing `serializers` already filter)
  - Dashboard rendering (escape HTML, but secret filter not needed for display — only for exports/logs)
- **Snapshots:** Addendum A already captures file content in git commits; secret filtering on export applies to any diff content embedded (it isn't — only summaries).

**Decision:** Do not pre-filter on write. Filter on read/export/log as today. Document in the spec.

---

## 7. Test Plan

### 7.1 Unit tests (Vitest, real SQLite in temp dirs)

| Category | Cases |
|----------|-------|
| **Transition validation** | Every allowed transition in §2.2 passes; every disallowed (e.g., `in_progress → completed`, `open → review`, `draft → in_progress`, agent calling `verify_task`) rejects with correct error code. |
| **Criteria locking** | Agent `update_task` on locked task → `CRITERIA_LOCKED`; `operator` update succeeds; `non_goals` editable only by `operator` when locked. |
| **Review submission** | Valid payload → `in_progress → review`, snapshot captured, `review_submission` row created, `review_submitted` event emitted. Invalid payload (missing evidence, empty tests) → `INVALID_REVIEW_SUBMISSION`. |
| **Verification** | Valid checklist (all 5 true) → `review → completed`, `verification` row, `task_verified` event. Missing checklist item → `INVALID_VERIFICATION`. Non-`operator` actor → `HUMAN_ONLY_ACTION`. |
| **Request changes** | Valid feedback → `review → in_progress`, `review_feedback` event. With rollback target → event includes `rollback_target_checkpoint_id`. Non-`operator` → `HUMAN_ONLY_ACTION`. |
| **MCP adapter** | `submit_for_review` tool works for agent; `approve_task`, `verify_task`, `request_changes` not registered; `agent_id === 'operator'` on any tool → `HUMAN_ONLY_ACTION`. |
| **Idempotency** | Same key + input → replay; different input same key → `IDEMPOTENCY_KEY_CONFLICT`. |
| **Migration** | Fresh DB gets new schema; existing DB (with tasks in old statuses) migrates: `criteria_locked=1`, `non_goals=[]`, statuses unchanged, no data loss. |
| **Resume context** | Same records → identical output; review feedback section appears in correct order; truncation preserves it. |
| **Export** | JSON validates against v3 schema; Markdown agrees with JSON; secret filtering works on all new text fields. |

### 7.2 Integration tests (real temp git repos, real project migrations)

1. **End-to-end flow (the happy path):**
   - Agent A creates task via MCP → status `draft`.
   - Human (operator) approves via dashboard API → `open`, `criteria_locked=true`, baseline snapshot captured.
   - Agent A claims → `in_progress`.
   - Agent A works, checkpoints, then `submit_for_review` with evidence/tests/gaps → `review`, review snapshot captured.
   - Human opens review screen, sees diff (baseline → review snapshot), evidence, tests, gaps.
   - Human checks all 5 checklist items, clicks Verify → `completed`, verification recorded.
   - Agent B resumes → resume context shows review feedback (none), verification, completed work.

2. **Request-changes round trip:**
   - Same as above until review screen.
   - Human clicks "Request changes", enters feedback, selects latest checkpoint as rollback target.
   - `request_changes` → `in_progress`, `review_feedback` event recorded.
   - Rollback engine runs (Addendum B) → working tree restored to checkpoint, safety + rollback snapshots captured.
   - Agent B claims → `in_progress`.
   - Agent B finishes, `submit_for_review` → `review`.
   - Human verifies → `completed`.

3. **Agent attempts human-only action:**
   - Agent calls `verify_task` via MCP → `HUMAN_ONLY_ACTION`.
   - Agent calls `approve_task` via MCP → not registered, would be `HUMAN_ONLY_ACTION` if somehow invoked.

4. **Criteria locking:**
   - After approval, agent tries `update_task` on `objective` → `CRITERIA_LOCKED`.
   - Agent tries `update_task` on `acceptance_criteria` → `CRITERIA_LOCKED`.
   - Agent tries `update_task` on `non_goals` → `CRITERIA_LOCKED`.
   - Operator updates all three via dashboard → succeeds.

5. **Migration test:**
   - Create a project DB at migration 004 (Addendum B state).
   - Insert tasks in various statuses.
   - Run migration 005.
   - Verify all tasks have `criteria_locked=1`, `non_goals=[]`, statuses intact, no errors.

6. **Cross-project isolation:**
   - Two projects, each with tasks in `review`.
   - Verify submissions/verifications are scoped to project DB.

### 7.3 MCP protocol tests
- `submit_for_review` tool appears in `tools/list`.
- `complete_task` does not appear.
- Human-only tools do not appear.
- `operator` actor rejection works.

### 7.4 Dashboard component tests (React Testing Library)
- Draft approval queue renders, approve modal works.
- Review screen renders diff summary, evidence table, tests, gaps, checklist.
- Checklist all-required enables Verify button.
- Request changes modal with checkpoint selector works.
- Task creation modal includes non_goals field.
- Status filter chips include draft/review.

### 7.5 Export tests
- JSON export validates against v3 schema.
- HANDOFF.md v3 contains all new sections.
- Secret filtering: seed `sk-test123`, `ghp_abc`, `AKIA...` in `summary`, `feedback_note`, `verification.notes` → exports have `[REDACTED]`.

---

## 8. Milestone Mapping (M1–M6 from MVP scope)

| Milestone | Current focus | Review gates work | R1 vs later |
|-----------|---------------|-------------------|-------------|
| **M1** Foundation | Workspace, TS, Fastify, SQLite, Drizzle, Zod, Vitest, Pino, migrations | **No** — too early | — |
| **M2** Durable task records | Task CRUD, claims, idempotency, events, checkpoints, decisions | **Core**: add `draft`/`review` statuses, `criteria_locked`, `non_goals` columns; transition function updates; `review_submissions`, `verifications` tables; new event types; migration 005. **R1** | R1 |
| **M3** MCP integration | 18 tools, routing, concurrent clients | **Core**: remove `complete_task`, add `submit_for_review`; adapter rejects `operator`; human-only tools not registered. **R1** | R1 |
| **M4** Resume & handoff | Deterministic resume, JSON export, HANDOFF.md, secret filtering | **Core**: resume context adds review feedback section; export v3 schema; HANDOFF.md v3; secret filtering on new fields. **R1** | R1 |
| **M5** Dashboard & recovery | Project/task views, history, checkpoint/decision inspection, recovery, exports | **Core**: draft approval queue, review screen (diff/evidence/checklist), task creation with non_goals, status filters, stats. **R1** | R1 |
| **M6** Hardening & validation | Full test suite, backup/restore, auth, e2e | **All**: run new transition/idempotency/migration/e2e tests; verify auth (loopback, no auth per AGENTS.md); backup/restore includes new tables. **R1** | R1 |

**Nothing waits for post-MVP.** The entire review-gates feature is R1 scope because it directly implements the "AI generates, humans verify" playbook requirement stated in the task. Post-MVP workstreams (WS-2..WS-10) are separate.

---

## 9. Risks and Open Questions

### 9.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Migration 005 (rebuild `tasks` table) breaks existing data | Medium | High | Follow Addendum A's proven rebuild pattern; test up-from-old-snapshot; pre-migration backup per project DB. |
| `operator` guardrail is bypassable (no auth) | Certain | Medium | Document clearly: "This is a guardrail, not tamper-proof security. R1 has no authentication." Dashboard and API also enforce. |
| Review submission snapshot (Addendum A `review` kind) conflicts with rollback snapshot logic | Low | Medium | Addendum A effective-snapshot derivation already handles multiple kinds; `review` kind is just another checkpoint-like snapshot. Test rollback after review. |
| Dashboard diff panel performance on large repos | Medium | Medium | Diff is path-level only (Addendum A `get_task_changes`); no raw content. Paginate if needed. |
| Criteria locking too strict: agents can't fix typos in acceptance criteria | Medium | Low | Agents use `block_task` with reason; human unblocks/edits. Document this flow. |
| Idempotency key generation for human actions (dashboard) | Low | Low | Dashboard generates UUIDv4 per action; stores in memory for retry. |
| Resume context size limit truncates review feedback | Low | Medium | Review feedback is in the "preserve" tier (like decisions). Test truncation. |

### 9.2 Open questions for meetb (must be resolved before implementation)

1. **Q1:** Human-created tasks start as `open` (skip draft) or `draft`?
2. **Q2:** `non_goals` schema: `string[]` with max 20 items × 500 chars — OK?
3. **Q3:** `evidence.how_checked`: free text or enum?
4. **Q4:** Reviewer checklist: fixed 5 items (R1) or configurable?
5. **Q5:** `request_changes` rollback target: human selects from checkpoints, default latest?
6. **Q6:** Criteria locking engages on `draft → open` — confirmed?
7. **Q7:** MCP adapter rejects `operator` for all tools — confirmed?
8. **Q8:** Existing tasks get `criteria_locked = 1` (grandfathered) — confirmed?
9. **Q9:** Resume context truncation preserves review feedback — confirmed?
10. **Q10:** Export schema version = 3 (Addendum B was 2) — confirmed?

> **Assumptions A1–A10** correspond to the proposed answers above. If any assumption is wrong, the spec will be updated before implementation.

---

## 10. Ordered Implementation Sequence (small, independently testable steps)

Each step produces a working, typechecked, lint-clean increment with tests.

| Step | Description | Files touched (representative) | Test focus |
|------|-------------|--------------------------------|------------|
| **0** | Create spec document (this file) under `docs/addenda/ADDENDUM-C-review-gates.md`. Record decisions in `docs/decisions.md` for any resolved Qs. | `docs/addenda/ADDENDUM-C-review-gates.md`, `docs/decisions.md` | — |
| **1** | **Shared contracts:** Add `draft`/`review` to status enum, `non_goals`, `criteria_locked` to task schemas; new Zod schemas for `approveTask`, `submitForReview`, `verifyTask`, `requestChanges`; new event types and payloads in `types/events.ts`; new error codes. | `packages/shared/src/schemas/task.ts`, `packages/shared/src/types/events.ts`, `packages/shared/src/errors.ts` | Unit: schema parse/validate, error codes |
| **2** | **Migration 005:** Rebuild `tasks` table with new columns/CHECK; extend `task_snapshots` `kind` CHECK to include `review`; create `review_submissions`, `verifications` tables. Embed migration. | `packages/core/db/migrations/005_review_gates.sql`, `packages/core/db/migrations-source.ts`, `packages/core/scripts/embed-migrations.ts` | Integration: up-from-004, data preserved, `criteria_locked=1` for existing tasks |
| **3** | **Domain transition function:** Update `TRANSITIONS` map; add validation branches for 4 new transitions; enforce `criteria_locked` in `updateTask`; capture baseline snapshot on `draft→open`; capture review snapshot on `submit_for_review`; create review_submission/verification rows; emit new events. All inside `IdempotencyService.run`. | `packages/core/src/domain/transitions.ts`, `packages/core/src/domain/task-service.ts`, `packages/core/src/domain/snapshot-service.ts` (reuse Addendum A) | Unit: every allowed/rejected transition; criteria locking; snapshot capture; event emission |
| **4** | **Core HTTP routes:** Add 4 new routes (`/approve`, `/submit-for-review`, `/verify`, `/request-changes`); map to domain service; validate with shared schemas. | `packages/core/src/http/routes/tasks.ts`, `packages/core/src/http/routes/index.ts` | Integration: each route returns 200/4xx correctly; transaction atomicity |
| **5** | **MCP adapter:** Remove `complete_task` tool; add `submit_for_review` tool (forward to new route); guard: reject `agent_id === 'operator'` on all tools with `HUMAN_ONLY_ACTION`; do not register human-only tools. | `packages/mcp-adapter/src/tools/register.ts`, `packages/mcp-adapter/src/tools/core-tools.ts`, `packages/mcp-adapter/src/client.ts` | Unit: tool list correct; operator rejection; submit_for_review works |
| **6** | **Resume context:** Add review feedback section in correct order; ensure truncation preserves it. | `packages/core/src/domain/resume-builder.ts` | Unit: deterministic output; order; truncation priority |
| **7** | **Export v3:** Bump `handoffJsonSchema` to v3; add new fields; update HANDOFF.md generator v3; secret filtering on new text fields. | `packages/shared/src/schemas/handoff.ts`, `packages/core/src/domain/export-service.ts` | Unit: JSON validates v3; Markdown agrees; secret filtering |
| **8** | **Dashboard — Draft approval queue:** New page/component; list draft tasks; approve modal with full task detail; calls `/approve`. | `packages/web/src/pages/DraftsPage.tsx`, `packages/web/src/components/tasks/ApproveModal.tsx`, `packages/web/src/api.ts` | Component: renders, approve calls API, updates list |
| **9** | **Dashboard — Review screen:** New page `/review/:taskId`; diff panel (reuse `get_task_changes`); evidence/tests/gaps panels; checklist (5 required); Verify and Request changes actions. | `packages/web/src/pages/ReviewPage.tsx`, `packages/web/src/components/review/*`, `packages/web/src/api.ts` | Component: renders all panels; checklist gates Verify; actions call API |
| **10** | **Dashboard — Task creation/edit:** Add `non_goals` field; default status `open` for human-created tasks. | `packages/web/src/components/tasks/TaskForm.tsx`, `packages/web/src/pages/ProjectDetailPage.tsx` | Component: non_goals saves; status default |
| **11** | **Dashboard — Lists and stats:** Add `draft`/`review` filter chips; update dashboard stats counts. | `packages/web/src/components/tasks/TaskFilters.tsx`, `packages/web/src/pages/DashboardPage.tsx`, `packages/core/src/http/routes/dashboard.ts` | Component: filters work; stats correct |
| **12** | **End-to-end integration test:** Full flow (agent creates → human approves → agent works → submits → human verifies → agent resumes). Real temp git repo, real migrations. | `tests/integration/review-gates-e2e.test.ts` | Integration: full flow passes |
| **13** | **Request-changes round-trip test:** Human requests changes with rollback → agent recovers → submits → human verifies. | `tests/integration/request-changes-rollback.test.ts` | Integration: rollback + rework flow |
| **14** | **Migration test:** Up from 004 snapshot with existing tasks. | `tests/integration/migration-005.test.ts` | Integration: data integrity |
| **15** | **Cross-project isolation test:** Two projects, concurrent reviews. | `tests/integration/cross-project-review.test.ts` | Integration: isolation |
| **16** | **Final hardening:** Run full test suite (119+ new tests), typecheck, lint, `pnpm smoke:exe`, backup/restore includes new tables. | All | All green |

---

## 11. Summary of New Artifacts

| Artifact | Location |
|----------|----------|
| Migration 005 | `packages/core/db/migrations/005_review_gates.sql` |
| Shared schemas | `packages/shared/src/schemas/task.ts` (extended), `packages/shared/src/types/events.ts` (extended), `packages/shared/src/errors.ts` (extended), `packages/shared/src/schemas/handoff.ts` (v3) |
| Domain transitions | `packages/core/src/domain/transitions.ts` |
| Domain services | `packages/core/src/domain/task-service.ts`, `packages/core/src/domain/snapshot-service.ts`, `packages/core/src/domain/resume-builder.ts`, `packages/core/src/domain/export-service.ts` |
| HTTP routes | `packages/core/src/http/routes/tasks.ts` |
| MCP tools | `packages/mcp-adapter/src/tools/register.ts`, `core-tools.ts` |
| Dashboard pages | `DraftsPage.tsx`, `ReviewPage.tsx`, `TaskForm.tsx`, `TaskFilters.tsx`, `components/review/*`, `components/tasks/ApproveModal.tsx` |
| Tests | `tests/integration/review-gates-e2e.test.ts`, `request-changes-rollback.test.ts`, `migration-005.test.ts`, `cross-project-review.test.ts`, plus unit tests per step |

---

## 12. Guardrail Statement (per AGENTS.md)

> **R1 has no authentication.** The `operator` actor restriction and the MCP adapter's rejection of human-only tools are **guardrails**, not tamper-proof security. A determined user with local access can bypass them by calling the HTTP API directly with `actor: 'operator'` or by modifying the database. This is documented and accepted for Release 1. Authentication is a post-MVP concern.

---

*End of Addendum C. Awaiting meetb's answers to Q1–Q10 before implementation begins.*