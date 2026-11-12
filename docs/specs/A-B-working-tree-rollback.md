# Spec — Addendum A (Working-Tree Snapshots) & Addendum B (Rollback to a Checkpoint)

Status: implemented incrementally per milestone M2–M6. This spec is the shared-contract
document for both addenda; where it differs from the MVP scope doc for snapshot/revert
topics, this spec wins (addenda > scope doc). Deviations agreed with meetb are called out
explicitly in "Agreed deviations".

Sources of truth precedence: root AGENTS.md "Decisions overriding the scope doc" >
Addendum B > Addendum A > `docs/mvp-scope.md`.

---

## 1. Agreed deviations (meetb, 2026-11-11)

1. **Task version deferred entirely.** Addendum B5/B6 requires `expected_version` on
   revert/rollback and a version bump on accepted rollback. Task versioning was removed
   stack-wide by D-004, and the MCP adapter derives idempotency keys from task version
   (bumping it would break equivalent retries). Revert/rollback therefore requires **no
   expected version and bumps none**. Concurrency safety is carried by:
   - owner-or-operator authorization,
   - the content-based preview fingerprint (apply rejects a stale preview with
     `preview expired: working tree changed, preview again`),
   - idempotency keys on apply.
2. **MCP tool count = 10**, not the addenda's 20: D-035 (newer decision) reduced the
   canonical surface to 7; the addenda's "20" was arithmetic against the pre-D-035
   17-tool surface. We add the 3 snapshot/revert tools to the canonical 7.

## 2. Invariants carried in (do not break)

- Only `packages/core` opens SQLite; MCP adapter and dashboard are thin HTTP clients.
- Append-only events with per-task monotonic sequence; no update/delete anywhere.
- Every state-changing operation: idempotency key + ownership; rejected calls leave no
  idempotency record, no state change and no event (IdempotencyService contract).
- One transaction per state-changing operation; git work first, DB record in the tx.
- Shared Zod schemas are the single contract for API, MCP adapter and dashboard.
- `execFile` with argument arrays only — never shell strings; never touch the user's
  index/branch/HEAD/stash (temp `GIT_INDEX_FILE`).
- Diff/patch content passes secret filtering; exports never embed raw diffs/file contents.

---

## 3. Data model (migration `004_rollback_snapshots.sql`)

Rebuilds `task_snapshots` (SQLite cannot alter a CHECK constraint):

- `kind CHECK IN ('baseline','checkpoint','safety','rollback')` — new `rollback` kind
  for the post-rollback snapshot.
- New nullable linkage columns (no FK, by design — the referenced snapshot always
  already exists, but a plain TEXT keeps the rebuild trivial and avoids drop/rename FK
  ordering issues):
  - `target_snapshot_id TEXT` — rollback target (set on `rollback` rows).
  - `safety_snapshot_id TEXT` — safety snapshot taken before the rollback apply
    (set on `rollback` rows).
- Existing rows copy with NULLs for the new columns; all other columns unchanged.

No `tasks.version` column is added (see deviation 1). The migration is appended (004),
never edited in place — already-applied ledgers must keep working. Regenerate embedded
migrations: `pnpm --filter @workjournal/core embed`.

Snapshot git refs: `refs/workjournal/<task-id>/<seq>` (hashed segment `wj-<sha1-prefix>`
as implemented in A2) keep all snapshot commits alive across GC.

## 4. Event contracts (shared `types/events.ts`)

Existing types extended (payloads are `.strict()`):

```
revert_applied: {
  task_id, preview_id,
  target_snapshot_id, target_kind: baseline|checkpoint|safety,
  effective_snapshot_id,                 // snapshot rolled back *from*
  reason: 1..2000 chars,                 // required (B5)
  safety_snapshot_id, rollback_snapshot_id,
  reverted_path_count, deleted_path_count,
  skipped_path_count, failed_path_count: non-negative ints,
  failed_paths: [{ path, reason }] capped (default [])   // partial application detail
}
revert_rejected: { task_id, reason }   // emitted ONLY for mid-apply failures (see §7.5)
snapshot_captured / snapshot_failed: kind enum gains 'rollback'
```

**Emission policy (invariant-driven):**

- `snapshot_captured` — every successful capture (baseline/checkpoint/safety/rollback).
- `revert_applied` — one per successful apply, inside the operation transaction.
- `revert_rejected` — only when an apply failed *after filesystem mutations began*
  (transaction rolled back; the event is written afterwards as a recovery audit trail:
  reason + safety ref survive so an operator can find the safety snapshot). Rejections
  before any mutation (auth, no-op, cross-task, stale preview, path escape,
  idempotency conflict) throw actionable errors and record nothing — same pattern as
  the transition function.
- `revert_previewed` stays in the catalog but is **not emitted**: preview is a read and
  the preview contract carries no idempotency key, so emitting an event would make a
  keyless state change (root AGENTS.md invariant). Reserved.

## 5. Snapshot semantics

### 5.1 Effective snapshot (read-time derivation, B4)

Definitions per task:

- Snapshots ordered by `sequence` (append-only, unique per task).
- Rollback events (`revert_applied`) ordered by event `sequence`, each resolving
  `target_snapshot_id → seq(T)` and `safety_snapshot_id → seq(S)` (events whose ids
  do not resolve are skipped defensively).
- A snapshot `X` is **rolled back** iff ∃ rollback event e with
  `seq(T_e) < X.sequence < seq(S_e)`. (The safety snapshot is captured immediately
  before the post-rollback snapshot, so exactly the snapshots created after the target
  and before the rollback apply are marked. Boundaries are exclusive: the target, the
  safety snapshot and the rollback snapshot itself are never rolled back.)
- **Effective snapshot** = the non-rolled-back snapshot with the highest `sequence`.
  Normally the latest checkpoint; right after a rollback it is the `rollback` snapshot;
  a later checkpoint supersedes it naturally.
- **Rolled-back checkpoints** = rolled-back snapshots with `kind='checkpoint'` —
  derived, never stored, never mutated (append-only preserved).

Everything that reads "latest" for change semantics uses the *effective* snapshot:
A5 change set (`baseline_to_latest` ⇒ baseline → effective), A7a drift (worktree vs
effective), `changed-since`, resume context, exports. After a rollback the change set is
`diff(baseline, rollback-snapshot)` by construction (the rollback snapshot's
`changed_vs_baseline` columns are computed at capture).

### 5.2 Capture flow (A2/A3, unchanged from Addendum A implementation)

Git first (execFile, temp index), then DB row + event in the caller's transaction;
idempotent retries create no second snapshot (capture runs inside the idempotency
callback); capture failure never blocks claim/checkpoint — row recorded degraded +
`snapshot_failed` event.

For rollback the capture is split so both snapshots commit atomically with the apply:
`captureOnly()` (git part, no DB) runs inside the apply transaction; `recordCaptured()`
inserts row + event.

---

## 6. Shared contracts (schemas/snapshot.ts)

### 6.1 Target

`target: string` optional, default `'baseline'`:

- `'baseline'` → the task's baseline snapshot,
- otherwise a snapshot id, which must belong to the same task and have
  `kind IN ('baseline','checkpoint','safety')` (a `rollback` snapshot may also be a
  target — undoing a rollback is "roll back to the safety snapshot", and any snapshot
  id works as long as it belongs to the task).

Rejections (actionable messages):
- different task → `target snapshot belongs to a different task`
- resolved target equals current effective state (same tree sha) →
  `target is the current state, nothing to roll back`
- unknown id → `target snapshot not found`

### 6.2 Preview — `preview_revert_task` (read-only)

```ts
previewRevertTaskSchema = {
  task_id, agent_id,                    // agent_id for owner-or-operator authorization
  target?: string,                      // default 'baseline'
}
```

No idempotency key: preview performs no state change (no events, no records, no
filesystem writes — "preview purity"). Authorization still applies (owner/operator),
because the preview is part of the revert flow and reveals working-tree detail.

**Plan computation** (shared by preview and apply):

- Path set = `git diff --name-status --no-renames <target> <effective>` (renames appear
  as A+D pairs, which apply handles as write+delete).
- If the target capture is degraded (no commit): path set = union of `changed_files`
  of all snapshots with `sequence > target.sequence` (paths that changed since the
  target), every path status `not-restorable` (reason: target has no git object).
- If the *effective* snapshot is degraded: ValidationError — plan cannot be computed.
- Not a git repo at all → `revert is unavailable: <root> is not a git repository`.

**Per-path status** — comparing target `T` tree, effective `E` tree, worktree `W`
(bytes/absence), in precedence order:

| # | condition | status | apply action |
|---|---|---|---|
| 1 | target degraded / blob unavailable | `not-restorable` | skip always (never forceable) |
| 2 | `W` exists and `W == T` | `clean` | no-op (already at target) |
| 3 | `W` missing, `T` has path | `restore` | write `T` bytes |
| 4 | `W` missing, `T` lacks path | `missing` | no-op (already absent per target) |
| 5 | `W == E`, `T` lacks path | `delete` | delete the file |
| 6 | `W == E`, `T` has path (`W != T` by diff) | `clean` | write `T` bytes |
| 7 | `W != E`, `T` has path | `changed-since` | **skip** unless in `force_paths` |
| 8 | `W != E`, `T` lacks path | `conflict` | **skip** unless in `force_paths` |

Exactly one status per path. Apply outcome groups: `{clean, restore}` →
`reverted_paths` (end at target content), `{delete, missing}` → `deleted_paths`
(end absent), `{changed-since, conflict}` → skipped unless force-listed,
`not-restorable` always skipped. Cases 7/8 mean the worktree diverged from the last
captured state since the plan's effective snapshot — applying would discard
uncommitted work (overwrite in 7, delete in 8).

Response:

```ts
previewRevertTaskResponseSchema = {
  task_id,
  target: { id, kind, sequence, commit_sha: string|null, capture_status },
  effective: { id, kind, sequence, commit_sha: string|null },
  paths: [{ path, status, reason? }],
  summary: { clean, restore, delete, missing, 'changed-since', conflict, 'not-restorable' },
  would_restore: string[],   // status restore (file currently absent, will be written)
  would_delete: string[],    // status delete (will be removed; `missing` needs no action)
  skipped_by_default: string[], // changed-since + conflict (need force_paths at apply)
  preview_id: string,
}
```

`preview_id` is **stateless** — no server-side preview store:

```
preview_id = "wjp1." + base64url(JSON({ v:1, t: task_id, k: target_key, e: effective_id, f: fp }))
fp = sha256(JSON([path, sha256(worktree bytes)|"ABSENT"] sorted by path over the path set))
```

Because `E` and `T` are immutable commits, the fingerprint over the path-set worktree
files fully determines the plan; any worktree change to a planned path (or a new
effective snapshot) changes the id. No wall-clock expiry — freshness is content-based.

### 6.3 Apply — `revert_task_changes` (state-changing)

```ts
revertTaskChangesSchema = {
  task_id, agent_id,
  target?: string,                // default 'baseline'; must match preview_id's k
  preview_id: string,
  reason: string (1..2000),       // required by B5
  force_paths?: string[] (≤200),  // per-path opt-in for changed-since/conflict
  idempotency_key,
}
```

Response:

```ts
revertTaskChangesResponseSchema = {
  task_id,
  target_snapshot_id, target_kind,
  effective_snapshot_id,            // state rolled back from
  safety_snapshot_id, safety_snapshot_sha,
  rollback_snapshot_id, rollback_snapshot_sha,
  reverted_paths: string[],         // now match target (writes + already-matching)
  deleted_paths: string[],          // absent per target (deletes + already-absent)
  skipped_paths: [{ path, reason }],
  failed_paths: [{ path, reason }], // partial application detail
  rolled_back_checkpoint_ids: string[],
  applied_at: string,
}
```

### 6.4 get_task_changes (A5/B)

Unchanged comparison enum; `baseline_to_latest` and drift now resolve *latest* to the
**effective** snapshot. `snapshot_to_snapshot` accepts any two snapshots of the task
(B: any snapshot as a comparison endpoint) — already the contract.

---

## 7. Rollback engine (core `domain/rollback-service.ts`)

One engine; whole-task revert (A6) is the special case `target = 'baseline'`.

### 7.1 Authorization

Owner-or-operator: `agent_id === OPERATOR` or `agent_id === task.owner`; otherwise
`OwnerMismatchError`. Applies to preview and apply. Task must exist.

### 7.2 Validation order (apply)

1. Task exists; authorization; `reason` present (schema-enforced).
2. Resolve target (same-task, found) and effective snapshot; both capture_status ok.
3. No-op check: `tree(target) == tree(effective)` → `target is the current state,
   nothing to roll back`.
4. Build plan; **path containment check** for every path: normalized relative path
   (no `..`, no absolute, no NUL), not under `.workjournal/`, resolved path stays inside
   the project root, and realpath of existing files/parent dirs stays inside the root
   (symlink escape) → else `ValidationError('path escapes the project root: <p>')`.
5. Decode `preview_id`; must match task, target key and current effective id; recompute
   fingerprint over current worktree → mismatch →
   `preview expired: working tree changed, preview again`.
6. If every path is `not-restorable` → ValidationError (target capture failed; nothing
   can be restored).

All of the above are read-only: a failure throws an actionable error and records
nothing.

### 7.3 Transaction layout

Everything below runs inside `IdempotencyService.run('idempotency_records', …, fn)`
(`BEGIN IMMEDIATE` → idempotency check → fn → record → `COMMIT`):

- **Replay check happens inside `run` before `fn`** → an equivalent retry returns the
  stored response without touching the working tree (this also sidesteps the stale-
  fingerprint problem on retries: validation lives inside `fn`, which replay skips).
- `fn`:
  1. Re-run validations 1–6 (idempotency check passed only means "same input as
     before", not "state is still valid").
  2. Capture **safety snapshot** (`kind='safety'`, git + row + `snapshot_captured`
     event).
  3. Apply the plan to the filesystem per path (write target bytes / delete), applying
     mode from `git ls-tree` (100755 → +x, 100644 → −x). Per-path `try/catch`;
     collected failures become `failed_paths`. `changed-since`/`conflict` paths apply
     only when listed in `force_paths`. `not-restorable`/`missing`/`clean`-no-ops need
     no writes (clean with `W==E` writes/deletes as per §6.2).
  4. Capture **post-rollback snapshot** (`kind='rollback'`, linked to target + safety;
     `changed_vs_baseline` computed against the baseline as usual).
  5. Insert `revert_applied` event (with reason, counts, failed paths).
  6. Return the response object (stored as the idempotency record).

Git refs created by steps 2/4 are outside SQLite; if the transaction later fails they
are orphaned refs (harmless, GC-able) and the filesystem may already have changed —
handled by 7.5.

### 7.4 Partial application

Filesystem writes cannot be rolled back by SQLite. Failures per path are collected,
not thrown; the operation still commits with `failed_paths` reported precisely in the
response and event (`failed_path_count`). If *all* paths fail, the same path applies
(committed with every path failed and reported) — callers see a fully-reported no-op
rather than an ambiguous error.

### 7.5 Mid-apply crash (invariant escape hatch)

If `fn` throws after filesystem mutation began (git/IO error outside per-path
catches), the transaction rolls back (no snapshot rows, no revert_applied, no
idempotency record) but files may have changed. We then write a single
`revert_rejected` event (`reason` includes the failure and the safety ref name if
known) as a post-failure audit record and rethrow an actionable error. This is the only
path that records an event for a rejected operation — it records that state diverged,
which the rolled-back transaction cannot.

### 7.6 Read helpers (shared derivation)

`getRollbackContext(taskId)` → `{ effective, rollbacks: [{…, rolled_back_snapshot_ids,
rolled_back_checkpoint_ids, reason, actor, created_at, target/safety/rollback ids}],
rolledBackIds }`, used by the engine, resume builder, exporters and the checkpoint
list (dashboard `rolled_back` flags). Derived at read time everywhere; nothing is
stored on checkpoints or snapshots.

---

## 8. HTTP routes (core, `/api/tasks` prefix)

| Route | Schema | Notes |
|---|---|---|
| `GET /:id/changes` | `getTaskChangesQuerySchema` | `task_id` injected from path when absent; must match when present |
| `GET /:id/snapshots` | `listSnapshotsQuerySchema` | snapshot list (dashboard resolves checkpoint → snapshot) |
| `POST /:id/revert/preview` | `previewRevertTaskSchema` | read-only; path/body task id must match |
| `POST /:id/revert` | `revertTaskChangesSchema` | mutation; `operationInput` strips the key for hashing |

Routes only validate/forward: no business logic outside core services.

## 9. MCP tools (adapter) — 7 canonical + 3 = 10

Thin HTTP forwarders registered in `core-tools.ts`, no new tool names beyond:

1. `get_task_changes` — task_id, comparison, from/to snapshot, include_diff/patch →
   `GET /api/tasks/:id/changes`.
2. `preview_revert_task` — task_id, target → `POST /api/tasks/:id/revert/preview`.
   Read-only annotation; injects session agent id and current task default.
3. `revert_task_changes` — task_id, target, preview_id, reason, force_paths →
   `POST /api/tasks/:id/revert`; derived idempotency key (existing
   `deriveIdempotencyKey` pattern, version component `?? 0` per deviation 1).

Shared Zod schemas define Core input/output; the adapter declares matching MCP input
shapes (existing convention: raw zod shapes in `registerTool`).

## 10. Resume context (B7)

`ResumeBuilder.build` additions (deterministic ordering — event sequence, then id):

1. **Rollback notice** (immediately after the header, prominent) when any rollback
   exists for the task: most recent rollback first — target checkpoint id, time (UTC
   as stored), actor, reason, rolled-back checkpoint ids. Multiple rollbacks listed
   newest first.
2. **Working checkpoint** = most recent *non-rolled-back* checkpoint (replaces "Latest
   Checkpoint"). Full detail (progress, next steps, completed work, findings,
   unresolved issues).
3. **Rolled-back checkpoints** section: compact entries (id, one-line progress summary,
   findings line) each marked `— not reflected in working tree`; details of rolled-back
   checkpoints are truncated **before** any protected content (working checkpoint,
   decisions, working-tree changes) when the size limit is approached, with an explicit
   truncation note.
4. **Working-tree changes** section: change set from the effective snapshot
   (`changed_vs_baseline` of the effective snapshot — i.e. `diff(baseline, effective)`)
   plus the safety snapshot id of the most recent rollback (`safety snapshot: <id>`).
5. **Decisions**: active decisions recorded after the rollback target (decision event
   sequence > target checkpoint's `checkpoint_recorded` event sequence) are marked
   `[recorded after rollback target]`.
6. Existing truncation fallback (hard slice at `sizeLimit` with a truncation note)
   remains the last resort.

No raw diffs/patches are ever embedded — summaries only.

## 11. Exports (B8)

**JSON (`handoffJsonSchema` v2):**

- `format_version: 2` (new, required — bump from implicit v1).
- `task`, `decisions`, `events` unchanged (events naturally include the new rollback
  event payloads, secret-filtered as today).
- `checkpoint` = the **working** (non-rolled-back) checkpoint — same shape as v1.
- New: `checkpoints: [{…, rolled_back: boolean, rolled_back_by?: { rollback_event_id,
  reason, actor, at }}]` — every checkpoint with its derived status.
- New: `rollback: { present, latest: { target_snapshot_id, safety_snapshot_id,
  rollback_snapshot_id, reason, actor, at, rolled_back_checkpoint_ids } | null,
  rollbacks: [...] }`.
- New: `snapshots: { baseline_id, effective_id, effective_sequence, effective_kind }`.
- Schema documented in `packages/shared/src/schemas/handoff.ts` and validated in tests
  (export output parsed through `handoffJsonSchema.parse`).

**Markdown (`HANDOFF.md`):**

- `Format: HANDOFF.md v2`.
- Working checkpoint section as today (heading notes `working checkpoint`), plus a
  `## Rollback` section when applicable and a `## Rolled-back Checkpoints` section
  (compact, marked not reflected in tree). Must agree with JSON on working vs
  rolled-back classification (test asserts agreement).
- No raw diffs; SHA/summaries only; secret filtering unchanged.

## 12. Dashboard (B9)

- Checkpoint timeline gains per-checkpoint **"Roll back to here"** (operator only):
  preview → shows path plan (statuses, counts, would-delete list) → reason input →
  confirm → apply. All content rendered escaped; diff-ish content secret-filtered
  (server side) — the dashboard only shows the preview summary (statuses/counts), never
  raw file content.
- API support: checkpoint list items gain derived fields
  `rolled_back: boolean` and `rolled_back_reason?: string` (read-time derivation);
  snapshot list route provides `checkpoint_id → snapshot_id` for the target.
- After a successful rollback: show safety snapshot ref + **"Undo this rollback"**
  action (re-runs the same flow with `target = safety_snapshot_id`, prefilled reason
  `undo rollback <at>`).
- Rolled-back checkpoints are visually marked with the rollback reason; timestamps
  converted to local time in the UI only (storage stays UTC).
- Actor for dashboard operations: `operator`.

## 13. Non-goals (B14)

Per-hunk rollback, auto-rollback, record rewriting (events/checkpoints/snapshots are
never mutated or deleted), status/decision rollback, cross-task or cross-project
rollback, wall-clock preview expiry, task version enforcement (deviation 1).

## 14. Tests (A12 + B11) — `backend/tests/integration/rollback.test.ts` (+ additions)

Real temporary git repos + real project migrations (`PROJECT_MIGRATIONS_DIR`), no DB
mocks; typecheck and lint clean.

Coverage list (B11):

1. Checkpoints 1-2-3, rollback to 2 restores only post-target changes (files added /
   modified after 2 revert; pre-2 content untouched; unrelated files untouched).
2. Create / delete / rename / mode-change handling end to end.
3. Baseline target ≡ A6 whole-task revert.
4. Safety-snapshot undo restores the pre-rollback tree.
5. Preview purity: preview writes nothing (working tree, snapshots, events unchanged).
6. `changed-since` skipped by default; applied when listed in `force_paths`.
7. `conflict` skipped by default (worktree diverged; target lacks path).
8. Stale preview rejected (`preview expired…`); worktree-changed-between detection.
9. Idempotency: same key+input replays stored response, no second apply, no second
   snapshot; different input with same key → `IDEMPOTENCY_KEY_CONFLICT`.
10. Auth: non-owner rejected (`OwnerMismatchError`), operator allowed; preview also
    authorized.
11. Reason required (schema 400).
12. Rejections: no-op target, cross-task target, path escape (`..`, absolute,
    `.workjournal/`) — actionable messages.
13. Degraded target reported `not-restorable` in preview; apply refuses.
14. Records preserved: event sequences append-only and monotonic; checkpoints and
    snapshots rows unchanged by rollback (ids, payloads); rolled-back flag derived.
15. Multiple rollbacks: derivation of rolled-back set + effective snapshot correct.
16. Effective snapshot correctness: change set after rollback = `diff(baseline,
    post-rollback)`; drift measured vs effective.
17. Resume/export determinism (same records → same content) and JSON/Markdown
    agreement on working vs rolled-back checkpoints; `handoffJsonSchema` validates.
18. Continuity scenario: Agent A checkpoints 1-3; operator rolls back to 2; Agent B
    resumes — sees rollback notice, working checkpoint 2, checkpoint 3 marked rolled
    back, working-tree changes vs effective.

## 15. Milestone mapping (A13/B12)

M2 (core engine) → M3 (MCP tools/routes) → M4 (resume/export) → M5 (dashboard) →
M6 (tests/e2e/docs). Implemented in that order; each milestone ships with its tests,
typecheck and lint.
