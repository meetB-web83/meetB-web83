# M15 — Agent-Facing MCP Surface (Core Profile)

**Status:** Draft for implementation  
**Date:** 2026-11-03  
**Decisions:** D-032 (core profile is default agent-facing surface)

---

## 1. Goal

The default MCP surface (`WORKJOURNAL_TOOLS=core`) is a **7-tool** agent-centric profile. An LLM coding agent reads `tools/list` cold, with no human explanation, and must:
- Know which tool to call and when (from name + description alone)
- Succeed on the first try (fewest required params; adapter fills ids/versions/keys)
- Recover from errors (one-sentence cause + one-sentence recovery)
- See the likely next action (`next_actions` in every response)

The existing 26-tool surface (~8,846 tokens) is preserved under `WORKJOURNAL_TOOLS=full` and `WORKJOURNAL_TOOLS=core+ledger` for backward compatibility and admin use.

---

## 2. Core Tools (7)

All tools are **thin wrappers** over existing core service operations. The adapter adds:
- Session state per MCP connection (current task id + version)
- Deterministic idempotency key derivation (unless caller supplies one)
- Project discovery from `WORKJOURNAL_PROJECT_ID` env or cwd marker walk
- Agent id derivation: `<clientInfo.name>_<project-id>` (fallback to `WORKJOURNAL_AGENT_ID`)
- Compact responses with `next_actions` (≤2 items, ≤25 words each)

### 2.1 `start_session`

**Description (≤40 words):**  
"Call first when starting or resuming work. Returns your in_progress tasks, a resume brief for task_id, and the next step. With task_id and claim=true, claims ownership. Browse tasks with list_tasks."

**Parameters:**
```json
{
  "task_id": "string?  // optional: specific task to resume/claim",
  "claim": "boolean?   // default false; true = claim this task (open/interrupted -> in_progress)",
  "project": "string?  // optional override; normally inferred from env/cwd"
}
```

**Behavior:**
1. Infer project (env `WORKJOURNAL_PROJECT_ID` > cwd `.workjournal/project.json` > arg `project`)
2. Get status counts for summary; get only this agent's `in_progress` tasks for the response
3. If `task_id` provided:
   - If `claim=true`: call core `claim_task` (handles both open and interrupted recovery)
   - Set as session's current task
   - Return its resume brief (compact `get_resume_context`)
4. If no `task_id` and exactly one candidate with `claim=true`: claim it and return brief
5. If no `task_id` and 0 or >1 candidates with `claim=true`: return error listing candidates (id + short title)
6. Return: `{ my_in_progress: [{id, title, status}], current_task: {...brief...}, next_actions: [...] }` plus a one-line count summary (e.g., "3 open, 1 in_progress, 1 interrupted, 12 completed")

**Maps to core:** `list_tasks` (filtered), `claim_task`, `get_resume_context`, `GET /api/tasks/counts`

---

### 2.2 `create_task`

**Description (≤40 words):**  
"Create a task for multi-step work. Becomes the current task."

**Parameters:**
```json
{
  "title": "string (required, ≤500 chars)",
  "objective": "string? (≤5000 chars)",
  "acceptance": "string[]? (≤1000 each, ≤50 items)",
  "priority": "'low' | 'medium' | 'high'? (default: medium)",
  "project": "string?  // optional override"
}
```

**Behavior:**
1. Infer project, derive agent id, generate idempotency key
2. Call core `create_task`
3. Set as session's current task
4. Return created task + next_actions: `["Call start_session to begin work."]`

**Maps to core:** `create_task`

---

### 2.3 `update_task`

**Description (≤40 words):**  
"Update the current task. status: in_progress=claim/resume, open=release/unblock (note=resolution), blocked|interrupted|cancelled need reason, completed=done. Other fields edit details."

**Parameters:**
```json
{
  "task_id": "string?        // optional; defaults to session's current task",
  "status": "'in_progress' | 'open' | 'blocked' | 'interrupted' | 'completed' | 'cancelled'?",
  "reason": "string?         // required when status is blocked|interrupted|cancelled",
  "note": "string?           // required when status=open on a blocked task (resolution_note)",
  "title": "string?          // ≤500 chars",
  "objective": "string?      // ≤5000 chars",
  "acceptance": "string[]?   // ≤1000 each, ≤50 items",
  "priority": "'low' | 'medium' | 'high'?"
}
```

**Behavior:**
1. Resolve `task_id` from arg or session state; error with candidates if unknown
2. Validate: `blocked|interrupted|cancelled` require `reason`; `open` on blocked requires `note`
3. Map to core operations:
   - `status=in_progress` → `claim_task` (or no-op if already owner)
   - `status=open` → `release_task` (if owner) or `unblock_task` (if blocked, with `note`)
   - `status=blocked` → `block_task` with `reason`
   - `status=interrupted` → `mark_task_interrupted` with `reason`
   - `status=completed` → `complete_task`
   - `status=cancelled` → `cancel_task` with `reason`
   - Field edits (title/objective/acceptance/priority) → `update_task`
4. If both `status` and field edits given: apply atomically via core (or reject with clear error)
5. On status change: update session's current task version; on terminal status, clear session task
6. Return updated task + next_actions (e.g., `"Task done. Call start_session for the next task."`)

**Maps to core:** `claim_task`, `release_task`, `unblock_task`, `block_task`, `mark_task_interrupted`, `complete_task`, `cancel_task`, `update_task`

---

### 2.4 `checkpoint`

**Description (≤40 words):**  
"Save progress so another agent can continue if this session ends. Call after each meaningful step and before stopping."

**Parameters:**
```json
{
  "task_id": "string?        // optional; defaults to session's current task",
  "summary": "string (required, ≤5000 chars)  // what was done",
  "next_steps": "string[] (required, ≤5000 each, ≤50 items)  // what to do next",
  "done": "string[]?         // completed_work, ≤10000 each",
  "findings": "string[]?     // current_findings, ≤10000 each",
  "issues": "string[]?       // unresolved_issues, ≤10000 each",
  "files": "string[]?        // file_references, ≤1024 each, ≤50 items"
}
```

**Behavior:**
1. Resolve `task_id` from arg or session state
2. Convert arrays to newline-joined strings if core expects strings (check existing `createCheckpointSchema`)
3. Generate idempotency key (include latest event sequence since checkpoints don't bump task version)
4. Call core `record_checkpoint`
5. Return: `{ checkpoint_id, next_actions: [...] }` with nudge if many events since last checkpoint

**Maps to core:** `record_checkpoint`

---

### 2.5 `record_decision`

**Description (≤40 words):**  
"Record a design choice others must follow. supersedes=<decision id> replaces an earlier one."

**Parameters:**
```json
{
  "task_id": "string?        // optional; defaults to session's current task",
  "decision": "string (required, ≤2000 chars)  // the decision statement",
  "rationale": "string?      // ≤5000 chars",
  "supersedes": "string?     // decision id to replace",
  "alternatives": "string[]? // ≤1000 each, ≤20 items"
}
```

**Behavior:**
1. Resolve `task_id` from arg or session state
2. If `supersedes` provided: call core `supersede_decision` (wraps replace + rationale)
3. Else: call core `record_decision`
4. Return: `{ decision_id, next_actions: [...] }`

**Maps to core:** `record_decision` + `supersede_decision`

---

### 2.6 `get_resume_context`

**Description (≤40 words):**  
"Get what another agent needs to continue: objective, status, last checkpoint, active decisions, open issues. detail=brief|full."

**Parameters:**
```json
{
  "task_id": "string?              // optional; defaults to session's current task",
  "detail": "'brief' | 'full'?     // default: brief (≤1500 tokens); full = existing configurable cap"
}
```

**Behavior:**
1. Resolve `task_id` from arg or session state
2. Call core `get_resume_context`
3. If `detail=brief`: truncate deterministically per existing priority rules (never drop latest checkpoint, active decisions, unresolved issues, next steps). Add `"truncated": true` marker if truncated.
4. Return context + next_actions (e.g., `"Call update_task to change status."`)

**Maps to core:** `get_resume_context`

---

### 2.7 `list_tasks`

**Description (≤40 words):**  
"See which tasks exist and which one to work on."

**Parameters:**
```json
{
  "status": "string?        // single value or \"all\"",
  "priority": "'low' | 'medium' | 'high'?",
  "limit": "number?         // default 10, max 25"
}
```

**Behavior:**
1. Infer project (env `WORKJOURNAL_PROJECT_ID` > cwd `.workjournal/project.json`)
2. Get status counts from `GET /api/tasks/counts`
3. If no `status` or `status="all"`: fetch actionable tasks (`in_progress` owned by this agent, then `interrupted`, then `open` by priority high→low)
4. If `status` specified: fetch that status only
5. Apply `limit` (default 10, max 25)
6. Return: one-line count summary (e.g., "3 open, 1 in_progress, 1 interrupted, 12 completed"), then one compact line per task: `id`, short title, status, priority, owner. End with "N more" when truncated, plus ≤2 `next_actions` (e.g., "Call start_session(task_id, claim=true) to resume one.")

**Maps to core:** `GET /api/tasks` (filtered), `GET /api/tasks/counts`

## 3. Adapter-Internal Mechanics

### 3.1 Session State (per MCP connection)

```typescript
interface SessionState {
  currentTaskId?: string;
  currentTaskVersion?: number;
  agentId: string;        // derived once per connection
  projectId?: string;     // discovered once per connection
}
```

- Stored on the `McpServer` instance (via `WeakMap` or closure)
- Updated after every write tool call
- `agentId` = `clientInfo?.name || 'opencode'` + `_` + `projectId` (validated suffix matches project)
- Override via `WORKJOURNAL_AGENT_ID` env

### 3.2 Idempotency Key Derivation

```typescript
function deriveIdempotencyKey(tool: string, taskId: string, version: number, args: object): string {
  const normalized = { tool, taskId, version, ...args };
  // Sort keys for determinism
  const canonical = JSON.stringify(normalized, Object.keys(normalized).sort());
  return 'wj-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
```

- For `checkpoint`: include `eventSequence` (latest event sequence for task) in hash so repeated checkpoints with new events don't collide
- Caller may supply explicit `idempotency_key` to override
- Core still requires and validates the key

### 3.3 Project Discovery

Same as existing: `WORKJOURNAL_PROJECT_ID` env > cwd walk for `.workjournal/project.json` > error with actionable message.

### 3.4 Response Shape

```json
{
  "content": [{ "type": "text", "text": "compact human-readable result (≤150 tokens typical)" }],
  "structuredContent": { "...": "essential result data" },
  "next_actions": ["Actionable next step (≤25 words)", "..."]
}
```

- `content` and `structuredContent` both carry essential result (some clients ignore structuredContent)
- `next_actions` ≤ 2 items, computed from stored data only (no LLM)

### 3.5 Error Shape

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "[CODE] Cause. Recovery." }]
}
```

- Stable error codes: `NO_PROJECT`, `NO_TASK`, `AMBIGUOUS_TASK`, `STALE_VERSION`, `NOT_OWNER`, `INVALID_TRANSITION`, `MISSING_REASON`, `IDEMPOTENCY_CONFLICT`
- One-sentence cause, one-sentence recovery
- No internals or secrets

---

## 4. Schema & Description Rules

- **Description:** ≤40 words, trigger/use-when first sentence (e.g., "Call first when...", "Save progress so...")
- **Property descriptions:** only when name isn't self-explanatory, ≤12 words each
- **No examples** inside schemas
- **Flat schemas only:** strings, numbers, booleans, string arrays, simple enums
- **No** `$ref`, `oneOf`, `anyOf`, nesting
- **Strip from serialized schema:** `$schema`, redundant `additionalProperties`, `title`, `defaults` (keep `type`, `properties`, `required`)
- **Tool annotations:** `readOnlyHint: true` for `get_resume_context`; `idempotentHint: true` for all write tools; `destructiveHint: true` for `update_task` with terminal statuses

---

## 5. MCP Initialize Instructions

```text
WorkJournal keeps task progress across agent sessions. Start with start_session. Checkpoint after each meaningful step and before stopping. Use update_task to change status.
```

≤80 tokens. Bonus only; descriptions must stand alone.

---

## 6. Profiles

| Profile | Tools | Use Case |
|---------|-------|----------|
| `core` (default) | 7 (above) | Agent-facing, minimal tokens |
| `full` | 17 (MVP spec §11) | Backward compatibility, admin |
| `core+ledger` | 16 (7 core + 9 ledger) | Opt-in plugin-style reporting |

**Ledger tools (opt-in only):** `get_dashboard`, `start_agent_session`, `end_agent_session`, `report_interruption`, `report_timeout`, `report_progress_milestone`, `report_fulfilment`, `report_verification`, `report_tool_call`

---

## 7. Prompts

- Remove test prompts `normal_updated` and `notification_test` from registry DB (cleanup script)
- Keep at most 3 built-in prompts (behind flag): `resume_task`, `create_checkpoint`, `record_decision`
- Each ≤80 words, fully working (`list` + `get`)
- Only advertise prompts capability when at least one prompt is registered

---

## 8. Tests (Vitest)

| Test | Purpose |
|------|---------|
| Budget | Measure serialized `tools/list` for `core`; threshold = measured value rounded up; target ≤2000 tokens, stretch 1500 |
| Schema flatness | Fail on `$ref`/`oneOf`/`anyOf`/nesting in core tools |
| Equivalence | Every `full` profile verb tool vs `update_task` mapping produces same DB state/events; invalid transitions leave DB unchanged; wrong owner/stale version/conflicting idempotency key rejected |
| Fallback task resolution | No session state, 0/1/many candidates |
| Profile switching | `core`, `full`, `core+ledger` expose exactly expected tool names; prompts work for declared |
| Inspector | MCP Inspector CLI mode against each profile; confirm tools list + full workflow loop |

---

## 9. Acceptance Test (Scripted)

A fresh agent, given ONLY the `core` `tools/list`, completes:

1. `list_tasks` → sees actionable tasks and count summary
2. `create_task` → task created, becomes current
3. `start_session(claim=true)` → claims task, returns brief
4. `checkpoint` → saves progress
5. `record_decision` → records design choice
6. `update_task(status=interrupted, reason="...")` → marks interrupted
7. **Second agent** (new connection): `start_session(task_id, claim=true)` → recovers, returns brief
8. `get_resume_context` → sees objective, checkpoint, decision, next steps

If any step needs a hint beyond the tool list, fix descriptions or responses.

---

## 10. File Changes

### New Files
- `docs/specs/M15-agent-surface.md` (this file)
- `packages/mcp-adapter/src/tools/session-state.ts`
- `packages/mcp-adapter/src/tools/core-tools.ts`
- `packages/mcp-adapter/src/tools/full-tools.ts` (existing tools passthrough)
- `packages/mcp-adapter/src/tools/ledger-tools.ts` (existing ledger tools passthrough)
- `scripts/cleanup-test-prompts.ts`

### Modified Files
- `packages/mcp-adapter/src/config.ts` — profile config, `WORKJOURNAL_TOOLS` env
- `packages/mcp-adapter/src/server-factory.ts` — pass profile, conditional prompts
- `packages/mcp-adapter/src/tools/register.ts` — dispatch to profile-specific registration
- `packages/mcp-adapter/src/index.ts` — CLI flag `--tools`
- `backend/package.json` — `mcp:inspect:core`, `mcp:inspect:full` scripts
- `backend/tests/integration/mcp-profile.test.ts` — profile tests
- `docs/decisions.md` — D-032 recorded

---

## 11. Rollback

- `WORKJOURNAL_TOOLS=full` restores byte-identical current behavior
- No core service, DB schema, transition table, or domain logic changes
- Repo's `opencode.json` pins `WORKJOURNAL_TOOLS=full` for dev agents