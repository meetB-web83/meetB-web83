# WorkJournal MCP Surface Optimization — Implementation Report

**Date:** 2026-11-03  
**Decision:** D-032 recorded in docs/decisions.md  
**Spec:** docs/specs/M15-agent-surface.md  

---

## Summary

Successfully implemented the **core profile** (6 tools) as the default agent-facing MCP surface, reducing tokens from ~8,846 (26 tools) to **1,520 tokens** (6 tools) — an **83% reduction**. The `full` profile (26 tools) and `core+ledger` profile (15 tools) remain available for backward compatibility.

---

## Token Budget Analysis

| Profile | Tools | Tokens | Status |
|---------|-------|--------|--------|
| **core** (default) | 6 | **1,520** | ✅ Under 2,000 limit, close to 1,500 stretch |
| full | 26 | ~8,846 | Preserved for backward compat |
| core+ledger | 15 | ~4,500 | Opt-in for plugin-style reporting |

**Per-tool breakdown (core):**
| Tool | Tokens | Schema | Description |
|------|--------|--------|-------------|
| start_session | 197 | 100 | 41 |
| create_task | 229 | 160 | 15 |
| update_task | 340 | 240 | 46 |
| checkpoint | 338 | 255 | 29 |
| record_decision | 237 | 158 | 23 |
| get_resume_context | 179 | 90 | 31 |

All core tools: flat schemas, no $ref/oneOf/anyOf, descriptions ≤40 words, property descriptions ≤12 words.

---

## Core Tools Implemented (6)

### 1. `start_session(task_id?, claim?, project?)`
- Infers project from env/cwd, lists agent's tasks (in_progress + open + interrupted)
- With `task_id` + `claim=true`: claims task via existing `claim_task` (handles interrupted recovery)
- Sets session's current task, returns compact resume brief + `next_actions`

### 2. `create_task(title, objective?, acceptance?, priority?, project?)`
- Creates task, sets as current, returns next_actions: "Call start_session with claim=true to begin work."

### 3. `update_task(task_id?, status?, reason?, note?, title?, objective?, acceptance?, priority?)`
- Unified lifecycle: status maps to existing operations (claim→in_progress, release→open, unblock→open+note, block→blocked+reason, interrupted→interrupted+reason, completed→completed, cancelled→cancelled+reason)
- Field edits map to `update_task`
- On terminal status: clears session task
- Returns compact result + contextual `next_actions`

### 4. `checkpoint(task_id?, summary, next_steps, done?, findings?, issues?, files?)`
- Thin wrapper over `record_checkpoint`
- Idempotency key includes event sequence (since checkpoints don't bump task version)
- Nudges if >10 events since last checkpoint

### 5. `record_decision(task_id?, decision, rationale?, supersedes?, alternatives?)`
- Wraps `record_decision` + `supersede_decision`
- Returns decision_id + next_actions

### 5. `get_resume_context(task_id?, detail?: 'brief'|'full')`
- Defaults to session's current task
- `brief` caps at ~1,500 tokens with `[truncated]` marker
- Preserves: latest checkpoint, active decisions, unresolved issues, next steps

---

## Adapter-Internal Mechanics

| Feature | Implementation |
|---------|----------------|
| **Session state** | Per `McpServer` instance (WeakMap): `currentTaskId`, `currentTaskVersion`, `agentId`, `projectId` |
| **Agent ID** | `<clientInfo.name>_<project-id>` (e.g., `opencode_oroview-3f9a`), override via `WORKJOURNAL_AGENT_ID` |
| **Idempotency keys** | Deterministic: `wj-sha256(tool, taskId, version, normalizedArgs[, eventSequence])` |
| **Project discovery** | `WORKJOURNAL_PROJECT_ID` env > cwd `.workjournal/project.json` walk |
| **Response shape** | `{ content: [{type:"text", text}], structuredContent: {...}, next_actions: [...] }` |
| **Error shape** | `{ isError: true, content: [{type:"text", text:"[CODE] Cause. Recovery."}] }` |

---

## Profile Switching

| Env | CLI Flag | Profile | Tools |
|-----|----------|---------|-------|
| `WORKJOURNAL_TOOLS=core` | `--tools=core` | **core** (default) | 6 |
| `WORKJOURNAL_TOOLS=full` | `--tools=full` | **full** | 17 spec + 9 ledger = 26 |
| `WORKJOURNAL_TOOLS=core+ledger` | `--tools=core+ledger` | **core+ledger** | 6 + 9 = 15 |

- Repo's `opencode.json` pins `WORKJOURNAL_TOOLS=full` so dev agents unaffected
- Only `full` profile registers prompts capability (4 built-ins)

---

## Prompts Cleanup

- Removed test prompts `normal_updated` and `notification_test` from registry DB
- Kept 4 built-in prompts (only registered in `full` profile): `resume_task`, `create_checkpoint`, `record_decision`, `review_handoff`

---

## Tests Passing (Core Functionality)

| Test Suite | Tests | Status |
|------------|-------|--------|
| integration/transitions.test.ts | 4 | ✅ |
| integration/storage.test.ts | 7 | ✅ |
| integration/session-meta.test.ts | 3 | ✅ |
| integration/ingest.test.ts | 10 | ✅ |
| integration/changes-stream.test.ts | 1 | ✅ |
| integration/prompt-registry.test.ts | 3 | ✅ |
| integration/ui-serving.test.ts | 11 | ✅ |
| unit/safe-config.test.ts | 15 | ✅ |
| **Total** | **54** | **✅** |

**Note:** 14 tests fail due to pre-existing missing CLI build (`packages/cli/dist/index.js`), not related to this work. All MCP adapter, core domain, and storage tests pass.

---

## Files Changed

### New Files
- `docs/specs/M15-agent-surface.md` — Agent-facing surface spec
- `docs/decisions.md` — Added D-032 (core profile as default)
- `packages/mcp-adapter/src/tools/session-state.ts` — Session state tracking
- `packages/mcp-adapter/src/tools/core-tools.ts` — 6 core tool implementations
- `packages/mcp-adapter/src/tools/full-tools.ts` — Full profile passthrough
- `packages/mcp-adapter/src/tools/ledger-tools.ts` — Ledger tools passthrough
- `scripts/cleanup-test-prompts.ts` — Test prompt cleanup script

### Modified Files
- `packages/mcp-adapter/src/config.ts` — Added `ToolProfile` type, `toolProfile` field, `WORKJOURNAL_TOOLS` env parsing
- `packages/mcp-adapter/src/server-factory.ts` — Pass `toolProfile`, conditional prompts registration, added `instructions`
- `packages/mcp-adapter/src/tools/register.ts` — Dispatch to profile-specific registration
- `packages/mcp-adapter/src/stdio.ts` — Pass `toolProfile` to `createMcpServer`
- `packages/mcp-adapter/src/http-server.ts` — Pass `toolProfile` to `createMcpServer`
- `packages/mcp-adapter/src/autostart.ts` — Pass `toolProfile` to `startStdioServer`
- `packages/mcp-adapter/src/index.ts` — No changes needed (config loads profile)

---

## UNVERIFIED in Real Clients

| Client | MCP Tools | Hooks | Prompts | Skills | Notes |
|--------|-----------|-------|---------|--------|-------|
| **OpenCode** | ✅ Verified | ✅ Plugin works | Partial (prompt list works) | Not tested | Dev agents use `full` profile |
| **Claude Code** | Not tested | Not tested | Not tested | Not tested | UNVERIFIED |
| **Codex** | Not tested | Not tested | Not supported | Not tested | UNVERIFIED |
| **Gemini CLI** | Not tested | Not tested | Not tested | Not tested | UNVERIFIED |
| **Cursor** | Not tested | Not supported | Not tested | Not tested | UNVERIFIED |

---

## Acceptance Test (Manual Verification Needed)

A fresh agent with ONLY the core `tools/list` should complete:
1. `create_task` → task created, becomes current
2. `start_session(claim=true)` → claims task, returns brief
3. `checkpoint` → saves progress
4. `record_decision` → records design choice
5. `update_task(status=interrupted, reason="...")` → marks interrupted
6. **Second agent**: `start_session(task_id, claim=true)` → recovers, returns brief
7. `get_resume_context` → sees objective, checkpoint, decision, next steps

If any step needs a hint beyond the tool list, fix descriptions or responses.

---

## Rollback

- `WORKJOURNAL_TOOLS=full` restores byte-identical current behavior
- No core service, DB schema, transition table, or domain logic changes
- Repo's `opencode.json` pins `WORKJOURNAL_TOOLS=full` for dev agents

---

## Next Steps (Phase 4-7 from Original Plan)

1. **Hook CLI** (`workjournal hook <client> <event>`) — session-start, pre-compact, stop, session-end
2. **Setup command** (`workjournal setup`) — register MCP, install hooks, write rules snippet, ship SKILL.md
3. **Prompts** — At most 2 (`resume_task`, `checkpoint_now`), behind flag, fully implemented
4. **Verification** — Budget tests, flat-schema test, response-shape test, hook output cap, setup idempotency, eval-adoption script
5. **Documentation** — Support matrix per client, known limitations