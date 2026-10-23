# WorkJournal Post-MVP Enhancement — Revised Execution Plan

Status: **For review — no implementation has begun.**
Date: 2026-10-23
Supersedes: the earlier MCP-in-core draft plan (single-process prerequisite removed per meetb's revision requirements).

This plan covers the post-MVP enhancements: unified event model (task + agent ledger),
automatic checkpoint evaluation, MCP resources, MCP prompts with a user-managed prompt
CRUD interface, change notifications, and an extensible agent-integration framework with
a `workjournal setup` terminal command (OpenCode first) — while preserving the existing
two-process Core/adapter architecture and every existing CLI command.

---

## 1. Existing Architecture & Behavior (Confirmed by Inspection)

### 1.1 Process architecture

```
workjournal.exe mcp --with-ui          (or: workjournal mcp [--transport http])
┌──────────────────────────────────────────────────────────────────────────┐
│ MCP Adapter process                                                      │
│  • @modelcontextprotocol/sdk 1.32.1, McpServer high-level API            │
│  • 18 tools registered via registerTools() (packages/mcp-adapter)        │
│  • stdio transport (default) or StreamableHTTP on 127.0.0.1:3738         │
│  • Serves the dashboard SPA when --with-ui                               │
│  • Host/Origin validation (validate-headers.ts, DNS-rebinding guard)     │
│  • Autostarts Core if down (D-013); idle-sweeper stops it last-one-out   │
│  • NEVER opens SQLite — forwards every call over loopback HTTP           │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTP 127.0.0.1:3737
                                ▼
workjournal.exe start --with-ui        (or: pnpm start in backend/)
┌──────────────────────────────────────────────────────────────────────────┐
│ Core service (Fastify)                                                   │
│  • REST API: /api/tasks, /api/events, /api/checkpoints, /api/decisions,  │
│    /api/resume, /api/export, /api/dashboard, /api/projects               │
│  • Owns ALL SQLite access: registry DB (~/.workjournal) + per-project    │
│    DBs (<project-root>/.workjournal/workjournal.db)                      │
│  • Migrations run lazily per project DB, embedded + source resolved      │
│  • All business logic: transitions, idempotency, ownership, versions     │
│  • Serves dashboard statically when --with-ui                            │
└──────────────────────────────────────────────────────────────────────────┘
```

Confirmed: `createMcpHttpServer()` (packages/mcp-adapter/src/http-server.ts) owns a
per-session registry over StreamableHTTP; `server-factory.ts` builds the McpServer;
`tools/register.ts` registers the 18 tools; `client.ts` forwards to Core over HTTP.
Docker Compose runs the same two services. SEA executable (`workjournal.exe`) bundles
both; migrations are embedded (decision D-011).

### 1.2 Key invariants (must not break)

- Only Core (`packages/core`) opens SQLite.
- MCP adapter is a thin forwarder; no business logic there.
- Shared Zod schemas are the single contract for API, MCP tools and dashboard.
- One transition function (`domain/transitions.ts`) validates every status change.
- Events are append-only with per-task monotonic `sequence`.
- Every state-changing operation requires an idempotency key, ownership and
  `expected_version` checks (decisions D-001..D-004).
- Resume context is deterministic — no LLM.
- Timestamps stored in UTC; only the dashboard converts to local.
- No authentication; loopback binding; secrets filtered from logs/exports.

### 1.3 Current database schema (per-project DB)

| Table | Notable columns |
|-------|-----------------|
| `tasks` | id, project_id, title, objective, acceptance_criteria, priority, status, owner, version, latest_checkpoint_id |
| `events` | id, project_id, task_id (NOT NULL), sequence, actor, event_type, payload (JSON), created_at |
| `checkpoints` | id, task_id, task_version, progress_summary, completed_work, current_findings, unresolved_issues, next_steps, file_references (JSON), created_at |
| `decisions` | id, task_id, statement, rationale, alternatives, supporting_event_ids (JSON), status, superseded_by, created_at |
| `idempotency_records` | key, operation, actor, input_hash, response, created_at |

Registry DB: `registry_projects`, `registry_idempotency` (plus planned `prompts` table — see §7).

Confirmed limitation: `events.task_id` is `NOT NULL`, so project-level (non-task) events
have no representation today. This must be addressed (see §3.1).

### 1.4 Current event types (shared/types/events.ts)

`task_created`, `task_updated`, `task_claimed`, `task_released`, `task_transitioned`,
`checkpoint_recorded`, `decision_recorded`, `decision_superseded` — all task-scoped,
all with validated payload schemas.

### 1.5 Current MCP adapter surface

- **Tools (18)**: create_task, get_task, list_tasks, update_task, claim_task,
  release_task, block_task, unblock_task, complete_task, cancel_task,
  mark_task_interrupted, record_checkpoint, record_decision, supersede_decision,
  get_task_history, get_resume_context, export_handoff, get_dashboard.
- **Resources**: none.
- **Prompts**: none.
- **Notifications**: none sent; no subscriptions handled.
- **SDK 1.32.1** (verified in node_modules): `McpServer.registerResource()`,
  `registerResourceTemplate()`, `registerPrompt()`, `sendResourceUpdated()`,
  `sendResourceListChanged()`, `sendPromptListChanged()`, `sendToolListChanged()`,
  `UriTemplate` with completions, and `ResourceTemplate` with a read callback — all
  available. The StreamableHTTP transport supports server-initiated notifications
  over the SSE stream of an open session.

### 1.6 Dashboard

- React 18 + Vite 6 + React Router 6; Coinbase Neo-Brutalism design system.
- `TaskDetailPage.tsx` loads checkpoints/events/decisions via `api.get()` and renders
  a chronological event list — currently flat, no category/source distinction.
- `ResumeContextPage.tsx` renders deterministic resume context.
- No prompt management UI exists.

### 1.7 Tests

119 tests green: unit (transitions), integration (storage, idempotency, mcp-stdio,
mcp-http, mcp-security, mcp-autostart, idle-sweeper, ui-serving, project-paths),
e2e (handoff-flow). `pnpm smoke:exe` validates the SEA build.

---

## 2. Revised Architecture & Key Decisions

### D-016 (proposed) — Preserve the Core/adapter split; MCP stays in the adapter

The adapter registers tools, resources and prompts; resource/prompt handlers call Core
REST APIs. No MCP-in-core move. A single-process layout is documented as an alternative
in §9.4 but is not a prerequisite.

**Bridge**: Core emits post-commit change notifications over an internal event bus and a
new, minimal long-poll/SSE endpoint (`GET /api/changes/stream`). The adapter subscribes
and translates Core change records into MCP `notifications/resources/updated`,
`notifications/prompts/list_changed`, and `notifications/resources/list_changed` for each
connected MCP session. Browser dashboard refresh is a separate, simpler mechanism
(NextJS polling → SSE later) and is not coupled to MCP.

### D-017 (proposed) — Canonical event envelope with source + category

Introduce a stable envelope: `event_id`, `occurred_at` (UTC), `source`
(`core` | `mcp_tool` | `agent:<agent-id>`), `category`, `type`, `project_id`,
`task_id` (nullable), `actor`, `payload` (validated per type), `sequence`.
Agent-reported events are recorded as ledger events — they never perform an
authoritative task transition. Low-level tool-call logging is opt-in.

### D-018 (proposed) — Checkpoint provenance via relational join table

A `checkpoint_sources` join table (checkpoint_id, event_id, role) over a JSON array:
referential integrity against append-only events, supports "which checkpoints cite this
event" queries, and matches existing relational conventions (no precedent for JSON
arrays being queried). Trade-off analysis in §5.2.

### D-019 (proposed) — Deterministic checkpoint policy; compaction deferred out of v2

Policy decides *whether* a checkpoint is warranted (pure function over task state,
latest checkpoint, and events since). Checkpoint *content* is assembled
deterministically from bounded event slices — no model runs in Core. The optional
compaction provider layer (Ollama/remote, §6.3) is explicitly deferred: the agent
itself produces the fulfilment/progress narrative through ledger events, and Core
only structures and validates it. The `Compactor` interface remains specified so a
provider can be added later without rework, but no provider, configuration, or test
surface lands in v2.

### D-020 (proposed) — Prompts are data in the registry DB, dual-scope with shadowing

Prompts are validated templates (message definitions), never executable code, stored
as rows in the registry DB with a nullable `project_id` (NULL = global scope).
Built-ins are seeded global rows, editable as overrides. A project-scoped prompt with
the same name shadows any global prompt or built-in **for that project only** —
global rows are never modified by shadowing and other projects are unaffected; the
dashboard shows "shadows global" badges. The MCP adapter resolves project scope by
matching its working directory against registered project roots (no match → global
prompts only) and re-reads the registry on change to re-register dynamically.

### D-021 (proposed) — Extensible agent-integration registry behind `workjournal setup`

Setup logic lives behind an `AgentIntegration` interface (discovery, plan, apply,
validate, uninstall, capabilities); the CLI iterates a frozen registry array. The only
adapter in this release is OpenCode; adding another agent (e.g. Cline) is a new adapter
file plus one registry entry — no changes to the setup command flow. Interactive
selection is a zero-dependency `node:readline` numbered multiselect (CLI stays
prompt-dep-free and SEA-safe). Config scope is global by default
(`~/.config/opencode/opencode.json(c)`), with an explicit `--project` flag for
cwd-local config. OpenCode config files are JSONC: merges use Microsoft
`jsonc-parser` minimal-edit operations so comments, formatting, and unrelated keys
survive; the parser's duplicate-key limitation is documented and reported.

### D-022 (proposed) — OpenCode lifecycle plugin: embed + extract, reports to a Core ingestion API

The lifecycle plugin is a small self-contained JS module authored in the repo, embedded
into the SEA executable at build time (same generated-embed pattern as migrations and
the dashboard UI, D-011), and written to `~/.workjournal/integrations/opencode/plugin/`
by `workjournal setup`. It default-exports `{ id, setup(ctx) }` (OpenCode V2 reads
`id`/`setup` off the export, so no `@opencode/plugin` runtime dependency is needed in
the extracted location — verified by spike, with a tiny embedded `Plugin.define` shim
as fallback). The plugin observes only reliably observable signals (session lifecycle,
interruption, idle, errors) via `ctx.event.subscribe()` and optional tool hooks, and
POSTs canonical envelopes to Core `POST /api/ingest/events`. Delivery is a bounded
queue in `ctx.storage` with backoff when Core is down — the plugin never autostarts
Core (the MCP adapter's D-013 autostart covers agent work sessions). Low-level
tool-call logging is opt-in via plugin options, default off. Idle/errors/interruption
are recorded as signals, never as proof of task completion.

### D-023 (proposed) — Ingestion API accepts ledger envelopes only; task transitions stay with the transition function

`POST /api/ingest/events` accepts a bounded batch of canonical envelopes restricted to
ledger categories (agent, progress, verification, recovery signals). Task-lifecycle or
transition-shaped payloads are rejected with 400 — the single transition function
(backend AGENTS.md invariant #2) remains the only path that changes task status.
Idempotency is by client-generated `event_id` (retry-safe dedup). The MCP adapter
forwards OpenCode's `ai.opencode/sessionID` tool-call `_meta` to Core, which maintains
a session↔task binding (established on successful claim-like tools) so later plugin
events for the same session are backfilled with `task_id`; unbound events remain
project-level (`task_id` NULL per §3.1).

---

## 3. WS-2: Standardize & Extend the Canonical Event Model

### 3.1 Task-level vs project-level events

`events.task_id` is currently NOT NULL. Recommendation: make it nullable in migration
`002_unified_events.sql` so project-level agent lifecycle events (session started with
no task context, project summary refresh) can be recorded. Events with `task_id = NULL`
appear in project-level history but not in per-task timelines. An index
`(project_id, task_id, sequence)` supports both query shapes.

### 3.2 Categories & new event types

| Category | Types (new marked *) | Notes |
|----------|----------------------|-------|
| task | task_created, task_updated, task_claimed, task_released, task_transitioned | existing |
| agent | agent_session_started*, agent_session_ended*, agent_interrupted*, agent_timed_out* | only where reliably observable |
| progress | progress_milestone*, progress_fulfilment* | fulfilment triggers checkpoint *evaluation* |
| decision | decision_recorded, decision_superseded | existing |
| verification | verification_passed*, verification_failed*, verification_skipped* | |
| recovery | checkpoint_recorded (existing), recovery_started*, recovery_completed* | |

Add `category` column (default `task`) and `source` column to `events`; index
`(task_id, category, sequence)`. Existing rows default to category `task`, source `core`.

### 3.3 Payload schemas (shared/types/events.ts)

Every new type gets a strict Zod payload schema. Agent events carry `agent_id`,
`session_id` where applicable, and bounded free-text fields (summary, findings,
blockers, next_steps, files_changed). Verification events carry `check_type` and
outcome detail. No schema allows an agent event to set `status` or mutate task state.

### 3.4 EventService extensions

- `recordAgentEvent`, `recordProgressEvent`, `recordVerificationEvent`,
  `recordRecoveryEvent` — all funnel through one internal `append()` that enforces
  sequence assignment, payload validation, idempotency, and per-task/project scope.
- Idempotent ingestion: an agent may resend an event with the same idempotency key;
  duplicate content with a new key is stored (append-only) but flagged in payload
  hash for policy dedup (see §5.3).

### 3.5 New MCP tools (adapter)

| Tool | Purpose |
|------|---------|
| start_agent_session / end_agent_session | record agent lifecycle |
| report_interruption / report_timeout | record interruption/timeout |
| report_progress_milestone | record a milestone |
| report_fulfilment | record fulfilment AND trigger checkpoint evaluation |
| report_verification | record pass/fail/skip |
| evaluate_checkpoint | run policy; create checkpoint only if warranted |

All require idempotency key + agent_id; none performs an authoritative transition.

**Acceptance**: new event types persist, validate, appear in task/project history with
source+category; idempotent ingestion proven; no agent event changes task status.

---

## 4. WS-3: Unified History in APIs & Dashboard

- `GET /api/events` accepts `category`, `source`, `task_id`/`project_id` filters and
  returns the enriched envelope. `EventService.listEvents` gains the same filters.
- Dashboard `TaskDetailPage` renders a unified chronological timeline: category chip,
  source badge (`core` vs agent id), authoritative vs claimed distinction (task
  transition rows visually distinct from agent claims), payload detail on expand.
- Project detail page gains a project-level history section for task-less events.

**Acceptance**: dashboard shows one merged timeline; filters work; existing tests pass.

---

## 5. WS-4: Checkpoint Schema & Provenance

### 5.1 Migration `003_checkpoint_provenance.sql` (project DB)

```sql
ALTER TABLE checkpoints ADD COLUMN creation_mode TEXT NOT NULL DEFAULT 'manual'; -- manual | auto
ALTER TABLE checkpoints ADD COLUMN trigger_event_id TEXT REFERENCES events(id);
ALTER TABLE checkpoints ADD COLUMN previous_checkpoint_id TEXT REFERENCES checkpoints(id);

CREATE TABLE checkpoint_sources (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'evidence',  -- evidence | trigger | baseline
  PRIMARY KEY (checkpoint_id, event_id, role)
);
CREATE INDEX idx_checkpoint_sources_event ON checkpoint_sources(event_id);
```

### 5.2 Trade-off: relational join table vs JSON array

| | Relational `checkpoint_sources` | JSON `source_event_ids` |
|---|---|---|
| Integrity | FK to append-only events; orphan-proof | none |
| Query "which checkpoints cite event X" | indexed join | JSON scan |
| Write cost | extra rows in same tx | one column |
| Convention fit | matches relational schema style | `decisions.supporting_event_ids` precedent |

Recommendation: relational table. `decisions.supporting_event_ids` remains as-is (no
retro-fit required) but new decision writes may also populate a `decision_sources`
table later; out of scope here.

### 5.3 CheckpointService changes

`createCheckpoint` accepts optional `creation_mode`, `trigger_event_id`,
`previous_checkpoint_id`, `source_event_ids[]`; in ONE transaction inserts the
checkpoint, inserts `checkpoint_sources` rows, updates `tasks.latest_checkpoint_id`,
and appends a `checkpoint_recorded` event. Idempotency key dedup prevents double
creation from retries. `getCheckpoint(checkpointId)` returns provenance.

Concurrency: the transaction re-reads `tasks.version` and refuses to describe a newer
version than the evidence supports (expected-version check).

---

## 6. WS-5: Deterministic Checkpoint Policy & Auto-Evaluation

### 6.1 Policy engine (core/domain/checkpoint-policy.ts)

Pure function: `evaluate(task, latestCheckpoint, eventsSinceCheckpoint, trigger) →
{ warranted, reason, suggestedContent, sourceEventIds }`.

**Warranted when** (any): fulfilment event with non-trivial summary; task transitioned
to completed/blocked/interrupted since last checkpoint; new decision recorded;
verification_failed since last checkpoint; ≥3 distinct files changed since last
checkpoint; >30 min elapsed AND ≥2 meaningful events.

**Not warranted when**: heartbeats/session-start/session-end only; duplicate fulfilment
(content-hash equal to a prior one); milestone without fulfilment; no material delta
vs. latest checkpoint.

Every evaluation (warranted or not) is appended as a lightweight `recovery` diagnostic
event with reason — useful for tuning without creating checkpoints.

### 6.2 Evaluation triggers

`report_fulfilment`, `evaluate_checkpoint`, `end_agent_session` with reason
interrupted/timeout/failed, `task_transitioned` to a terminal/blocked state, explicit
recovery request. Manual `record_checkpoint` bypasses policy entirely (still available).

### 6.3 Content generation — deterministic only in v2 (compaction deferred)

Checkpoint content is assembled by a deterministic `DeterministicCompactor`: completed
work / remaining / decisions / blockers / files / verification status / next action,
built from bounded event slices (task + latest checkpoint + N most-relevant events).
Output is validated against the checkpoint Zod schema. The narrative inputs come from
the agent itself via fulfilment/progress ledger events — Core structures them and
never invents them: validation enforces that e.g. `completed_work` cites source event
ids present in the input set, and an agent claim is never promoted to verified
evidence or allowed to override authoritative task state.

**Deferred (specified, not built in v2):** the optional `Compactor` provider layer —
interface `Compactor { compact(inputs): CheckpointContent }` with future
`OllamaCompactor` / provider-agnostic remote implementations (meetb's decision: v2
relies on the agent itself; no model in Core). The seam replaces only the
content-assembly step behind the same validation, so a provider can be added later
without rework.

**Acceptance**: policy deterministic and unit-tested; auto-checkpoints carry
provenance; manual tool unchanged; no model anywhere in Core.

---

## 7. WS-6: MCP Resources

### 7.1 URI scheme & templates (workjournal://)

| URI template | Source |
|--------------|--------|
| workjournal://projects | GET /api/dashboard |
| workjournal://projects/{project_id} | GET /api/dashboard?project_id |
| workjournal://projects/{project_id}/tasks | GET /api/tasks?project_id |
| workjournal://projects/{project_id}/tasks/{task_id} | GET /api/tasks/{task_id} |
| .../tasks/{task_id}/resume | GET /api/resume?task_id |
| .../tasks/{task_id}/history | GET /api/events?task_id |
| .../tasks/{task_id}/checkpoints | GET /api/checkpoints?task_id |
| .../tasks/{task_id}/checkpoints/{checkpoint_id} | GET /api/checkpoints/{checkpoint_id} |
| .../tasks/{task_id}/decisions | GET /api/decisions?task_id |

Registered in server-factory.ts via `registerResource` / `registerResourceTemplate`
with completions for project_id/task_id. Handlers are read-only, bounded, and call
Core APIs — no duplicate business logic, no checkpoint creation on read.

### 7.2 Invalidation & notifications

Core emits post-commit change records; adapter maps them to affected URIs and sends
`sendResourceUpdated({uri})` per subscribed session. `sendResourceListChanged()` only
when the resource *list* changes (rare). Reads never mutate; clients that miss
notifications refetch authoritatively (stateless design, no replay).

### 7.3 Client access documentation

Resources are discoverable by capable clients (resources/list); agents that ignore
resources retain every existing tool as fallback. Documented in the CLI/README.

**Acceptance**: all resources readable over stdio + StreamableHTTP; completions work;
notifications fire only on committed changes; existing tools untouched.

---

## 8. WS-7: Prompt CRUD Workstream (Core + Dashboard + MCP)

### 8.1 Persistence — registry DB migration `003_prompts.sql`

```sql
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom',   -- resume | checkpoint | decision | handoff | custom
  template TEXT NOT NULL,                    -- message template with {{arg}} placeholders
  arguments TEXT NOT NULL DEFAULT '[]',      -- JSON: [{name, description, required, type}]
  project_id TEXT REFERENCES registry_projects(id),  -- NULL = global scope (D-020)
  is_builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Name uniqueness per scope (SQLite UNIQUE treats NULLs as distinct):
CREATE UNIQUE INDEX ux_prompts_name_global ON prompts(name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX ux_prompts_name_project ON prompts(name, project_id) WHERE project_id IS NOT NULL;
```

Seeded built-ins (resume_task, create_checkpoint, record_decision, review_handoff) are
inserted idempotently (against the global unique index, `ON CONFLICT DO NOTHING`) so
user edits survive upgrades. Built-ins are editable as overrides (version bump
recorded) and duplicable; they are never hard-deleted (API returns
`BUILTIN_PROMPT_PROTECTED`). Templates are plain text + validated `{{arg}}`
placeholders — no code execution, no bypass of ownership/transition checks (any
action still goes through the normal MCP tool).

**Scope (D-020, confirmed by meetb):** dual-scope. `project_id` NULL = global; set =
a project prompt semantically owned by that registered project, stored in the
registry so one API/dashboard/MCP sync serves both scopes. Project rows shadow
same-named global prompts or built-ins for that project only; shadowing never
modifies the global row. Project DBs remain pure per-project state — prompts are not
stored in them.

### 8.2 Core API (routes/prompts.ts + domain/prompt-service.ts)

| Endpoint | Notes |
|----------|-------|
| GET /api/prompts | filter: `scope=global\|project`, `project_id`, category, enabled, include_builtin; `resolved=1` returns the effective set for a project (project shadows global/built-in by name) |
| POST /api/prompts | Zod-validated; `project_id` optional (absent = global); idempotency key; name unique within its scope |
| GET /api/prompts/{id} | 404 → NotFoundError |
| PATCH /api/prompts/{id} | optimistic version check; idempotency; scope immutable after creation |
| DELETE /api/prompts/{id} | custom only; builtin → 400 BUILTIN_PROMPT_PROTECTED |
| POST /api/prompts/{id}/toggle | enable/disable |
| POST /api/prompts/{id}/preview | render template with sample args, validation errors surfaced |

Follows existing validation hook + error catalog conventions. Resolution order for a
given name within a project: project-scoped row → global custom row → built-in; a
disabled winner hides the name entirely (no fall-through to the shadowed row —
disabling is an explicit choice).

### 8.3 Dashboard UI

New page `PromptsPage.tsx` (+ `components/prompts/` PromptForm, PromptList,
PromptPreview) routed at `/prompts`, `/prompts/new`, `/prompts/:id/edit`. Features:
browse with built-in/user badges and a Global/Project scope column; scope selector on
create (global, or pick a registered project); "shadows global"/"shadows built-in"
badges on project prompts whose name collides; edit name/description/category/template;
argument builder (name, description, required, type); template editor with `{{arg}}`
highlight; live preview with example values (project-scope preview shows the shadowed
resolution); duplicate-as-custom (duplicating into a project scope is the natural way
to customize a built-in per project); enable/disable toggle; delete confirmation
(disabled for built-ins); inline validation errors. Uses existing design tokens and
`api.ts` conventions. Changes persist across restarts; no executable rebuild.

### 8.4 MCP integration (adapter)

Dynamic prompt registry (`mcp-adapter/src/prompts/registry.ts` + `sync.ts`): the
adapter fetches enabled prompts from Core at startup, registers each via
`registerPrompt()` with a render callback that fetches the current row and renders the
template into `GetPromptResult` messages with validated arguments. On prompt CRUD, Core
emits a change record; the adapter re-syncs and, where the transport supports it, sends
`sendPromptListChanged()`. Because MCP servers cannot unregister prompts at runtime in
SDK 1.32.1, the sync layer maintains a name→id map and treats deleted/disabled prompts
as "render returns an explanatory error" until the session restarts — documented as a
client-facing limitation with the workaround (reconnect or ignore cached list).

**Project-scope resolution:** MCP has no notion of "current project", so the adapter
resolves scope by matching its working directory against registered project roots
(OpenCode spawns local MCP servers with the workspace as cwd — confirmed behavior;
a `WORKJOURNAL_PROJECT_ID` environment escape hatch is added to the MCP entry for
clients that spawn with a different cwd). Registered match → effective set = project
rows shadowing global/built-in names; no match → global prompts only. The name→id map
is built from the resolved effective set, so two projects connected simultaneously
(each with its own adapter process) see their own scope.

### 8.5 Prompt behavior guarantees

`resume_task` guides the client to read the resume resource then call `claim_task`;
retrieving a prompt performs no mutation. Prompts never contain secrets and are
secret-filtered on export like other content.

### 8.6 Tests

CRUD API tests (both scopes; scope immutability; per-scope name uniqueness);
shadowing resolution matrix (project over global, project over built-in, global over
built-in, disabled winner hides the name); persistence-across-restart; validation/
built-in protection; rendering with required/optional/missing args; MCP prompt
discovery over stdio + StreamableHTTP **in both resolution modes** (registered
project cwd → shadowed set; unregistered cwd → global only; `WORKJOURNAL_PROJECT_ID`
override); list-changed notification after registry mutation; and an end-to-end test:
create a project-scoped prompt via dashboard API → a project-resolved MCP session
sees the shadowing version while a global session sees the original → **without
rebuilding WorkJournal**.

---

## 9. WS-8: Change Notifications (decoupled from dashboard)

### 9.1 Core side

After each successful commit, services append an internal change record:
`{ resource_type, resource_id, project_id?, task_id?, change, occurred_at }`. Core
exposes `GET /api/changes/stream` (SSE) and a bounded `GET /api/changes?since=` long-poll
fallback. No notification is emitted before commit — failed writes produce nothing.

### 9.2 Adapter side

One Core change subscription per adapter process; fan-out to each connected MCP session.
Reconnection: exponential backoff; on reconnect the adapter does an authoritative
refetch (prompts re-sync; resources are stateless so nothing to replay). Missed
notifications are tolerated by design — clients refetch.

### 9.3 Dashboard side

Separate lightweight polling (existing pattern) or a dedicated SSE endpoint later; the
dashboard is NOT coupled to MCP notifications.

### 9.4 Alternative (documented, not chosen): single process

Merging MCP into Core would remove the bridge entirely and allow in-process emitters —
at the cost of coupling stdio MCP lifecycle to the long-running service, changing
`mcp --with-ui` semantics, complicating SEA packaging, and breaking the "adapter never
touches SQLite" isolation that makes the security model simple. Deferred unless the
bridge proves unreliable in practice.

---

## 10. WS-9: Agent Integration Framework & Terminal Setup

New requirement: an extensible agent-integration system, OpenCode-only in this release,
installed by `workjournal setup` runnable from any working directory. Design decisions
D-021–D-023 (§2) capture the confirmed choices (readline multiselect, global default
scope, embed+extract plugin, jsonc-parser merges).

### 10.1 Confirmed current CLI & packaging architecture

- `packages/cli` — commander program (`src/program.ts`) shared by the normal ESM entry
  (`index.ts`) and the SEA entry (`standalone.ts`); five subcommands (`start`, `stop`,
  `status`, `backup`, `mcp`); zero interactive-prompt dependencies; `status` is the
  precedent for a diagnostic command; `utils/home.ts` resolves `WORKJOURNAL_HOME`.
- SEA packaging (`backend/scripts/build-exe.ts`) already embeds assets at build time
  (migrations via `embedded-migrations.generated.ts`, dashboard UI) — decision D-011 —
  and `pnpm smoke:exe` validates the binary with no node_modules present.
- `workjournal mcp` (stdio) with D-013 autostart is exactly the command an OpenCode
  local MCP server entry should invoke — no new transport, no CLI behavior change.

### 10.2 Integration registry interface (packages/cli/src/integrations/)

```ts
interface AgentIntegration {
  id: string;                        // stable id, e.g. "opencode"
  displayName: string;
  supportedPlatforms: NodeJS.Platform[];
  capabilities: { mcp: boolean; lifecyclePlugin: boolean; hooks: string[] };
  discover(env: SetupEnv): Promise<DiscoveryResult>;   // installed? config paths? state
  plan(ctx: SetupContext): Promise<ConfigPlan>;         // pure — computes edits, no writes
  apply(plan: ConfigPlan): Promise<ApplyResult>;        // backup + atomic writes only
  validate(ctx: SetupContext): Promise<ValidateResult>; // post-write verification
  uninstall(ctx: SetupContext): Promise<ApplyResult>;   // removes ONLY managed entries
}
```

File layout:

```
packages/cli/src/integrations/
  types.ts                    — AgentIntegration + shared result types
  registry.ts                 — frozen [opencodeIntegration]
  setup.ts                    — command flow: flags, multiselect, summary report
  safe-config.ts              — agent-agnostic JSONC load/merge/backup/atomic-write
  adapters/opencode/
    discovery.ts              — OS paths, binary detection, state classification
    merge.ts                  — managed entries: mcp.servers.workjournal + plugins
    plugin/index.js           — lifecycle plugin source (embedded at build time)
    plugin.generated.ts       — committed embed output (D-011 pattern)
```

`DiscoveryResult` states (per integration): `not_installed`, `installed_not_configured`,
`configured`, `configuration_error` — each with evidence (paths checked, parse error
location). A future Cline adapter implements the same interface; `capabilities`
explicitly represents agents that support MCP but not lifecycle plugins.

### 10.3 OpenCode discovery & safe-merge strategy

- **Paths (platform-aware, no hardcoded single-OS path):** Windows
  `%USERPROFILE%\.config\opencode\`; POSIX `$XDG_CONFIG_HOME/opencode/` else
  `~/.config/opencode/`; file `opencode.json` or `opencode.jsonc` (first existing wins;
  when none exists, create strict-JSON `opencode.json` at the global location).
  Binary detection via `opencode --version` (`where`/`command -v`). macOS location
  confirmed against docs in the implementation spike.
- **Parse before touching:** jsonc-parser load; parse failure → `configuration_error`,
  original file untouched, error location reported. Never modify an unparseable file.
- **Minimal edits only:** `modify()` operations that set `mcp.servers.workjournal` and
  append the plugin path to `plugins` (matched by `~/.workjournal/integrations` prefix).
  All other keys, unknown fields, comments, and formatting preserved. Documented
  limitation: pre-existing duplicate keys are reported, and edits target the first
  occurrence (jsonc-parser behavior).
- **Conflict rule:** an existing `workjournal` server entry pointing at a different
  command/env → conflict; require `--force` or interactive confirmation. Never silent
  overwrite of user-customized entries.
- **Safe write:** applyEdits → temp file in the same directory → atomic rename;
  pre-write backup `<file>.workjournal-backup-<ISO-timestamp>`; re-parse + validate
  after write; validation failure → restore backup and report.
- **Idempotency:** re-run with identical managed values → "already configured, no
  changes"; differing managed values → in-place update of only those values. No
  duplicate servers or plugin entries ever.
- **Uninstall:** removes only the `workjournal` MCP server key and the plugin entry
  whose path is inside `~/.workjournal/integrations`; never touches other entries.

### 10.4 Plugin & MCP installation strategy

- **MCP entry:** `mcp.servers.workjournal = { type: "local", command: [<exe>, "mcp"] }`
  where `<exe>` is `process.execPath` under the SEA executable, or
  `["node", <abs cli dist path>, "mcp"]` in dev runs. `WORKJOURNAL_CORE_URL` is passed
  through `environment` only when overridden (defaults inherited). Argv arrays, no
  shell — spaces in paths are safe by construction.
- **Plugin:** embedded at build time; setup writes `index.js` +
  `manifest.json` (version, sha256) to `~/.workjournal/integrations/opencode/plugin/`;
  the `plugins` config entry uses the absolute directory path with object-form options
  (`coreUrl`, plugin version). Re-running setup refreshes the file when the hash differs.
- **Event mapping (exact OpenCode event names spike-verified at implementation time):**

  | Observable OpenCode signal | Canonical event |
  |---|---|
  | session created | `agent_session_started` |
  | session ended/removed (+ reason) | `agent_session_ended` (completed/interrupted/failed/timeout) |
  | interruption observed | `agent_interrupted` |
  | idle detected | `agent_idle` (small WS-2 addition, category `agent`) — a signal for checkpoint evaluation, never fulfilment |
  | terminal tool-call error (opt-in) | verification-category signal only when the call is a checks/tests tool; otherwise an agent error signal |
  | tool call start/end (opt-in only) | `agent_tool_call` — plugin option `logToolCalls`, default OFF |

- **Correlation:** OpenCode sends `ai.opencode/sessionID` in `tools/call` `_meta`
  (confirmed in OpenCode docs). The MCP adapter forwards it to Core with each call;
  Core establishes the session↔task binding on successful claim-like tools; plugin
  events for that session get `task_id` backfilled, others stay project-level.
- **Delivery:** POST to `POST /api/ingest/events`; bounded queue in `ctx.storage` with
  backoff when Core is unreachable; drop-after-limit with logged warning; no plugin-side
  Core autostart.

### 10.5 Core ingestion API (coordinates with WS-2)

`POST /api/ingest/events` (packages/core/src/http/routes/ingest.ts +
domain/ingest-service.ts): bounded batch (≤50), shared Zod envelopes from WS-2,
ledger categories only (D-023), `event_id` dedup, `source` required
(`agent:opencode@<pluginVersion>`), loopback + payload-size limits as everywhere else.
Response: per-event `accepted | duplicate | rejected` with reasons.

### 10.6 Setup command UX & behavior

```
workjournal setup [--agent opencode] [--global|--project] [--dry-run] [--yes]
                  [--force] [--uninstall] [--status]
```

- Works from any CWD (global scope is the default; `--project` writes `./opencode.json(c)`
  in the current directory, explicitly requested).
- No flags + TTY → detect integrations → readline numbered multiselect (only OpenCode
  listed; `not_installed` entries shown with reason, unselectable) → plan → preview →
  apply → summary. `--yes`/`--agent` skip prompts (automation + tests).
- `--dry-run`: prints every file that would change and the exact managed entries — zero
  writes. `--status`: non-interactive diagnostic per agent (state, config paths, command
  validity, plugin version present, backup locations). `--uninstall`: reverse only
  managed entries.
- Summary reports per integration: found / updated / skipped / failed + backup paths +
  "restart OpenCode (or run /reload) to pick up changes" hint when applicable.
- Handles: missing permissions (EACCES → clear error, no partial state), invalid
  config (never modified), conflicting entries (blocked without `--force`), unsupported
  platform (adapter filtered out by `supportedPlatforms`).

### 10.7 Backup, conflict, rollback, idempotency rules (consolidated)

| Rule | Behavior |
|---|---|
| Backup | timestamped copy before any modification of an existing file |
| Atomic write | temp file + rename in the same directory |
| Rollback | post-write validation failure → restore backup, report, exit non-zero |
| Conflict | differing existing `workjournal` entry → blocked without `--force` |
| Idempotency | identical managed values → no-op; differing → in-place minimal update |
| Invalid input | unparseable config → untouched + explained |
| Uninstall | managed entries only; user/other entries never touched |
| Partial failure | per-file results; one failing integration never blocks another's report |

### 10.8 OS & installation-scope considerations

Windows / macOS / Linux path resolution via env (`USERPROFILE`/`HOME`/`XDG_CONFIG_HOME`)
with the same `workjournalHome()` expansion convention already used by the CLI. Global
scope satisfies "run from any directory"; project scope is explicit opt-in and never
assumes the cwd is the WorkJournal repo. Exe-path staleness (binary moved after setup)
is detected by `--status` and fixed by re-running setup with `--force`.

### 10.9 Acceptance criteria & test plan

**Acceptance:** setup from any directory configures OpenCode correctly; repeated runs
are no-ops; comments/unrelated settings survive; invalid configs are never touched;
uninstall removes only WorkJournal entries; plugin events arrive at Core as canonical
envelopes and never mutate task status; no new runtime deps beyond `jsonc-parser`.

- **Unit:** registry iteration; per-OS path discovery (env-mocked); JSONC merge
  fixtures (comments preserved, unrelated keys, existing entries, conflicts, duplicate
  keys reported); backup/rollback; idempotency.
- **Integration:** spawn the built CLI from a temp cwd outside the repo with redirected
  `HOME`/`USERPROFILE`; dry-run makes zero writes; invalid config untouched; uninstall
  scope; permission-denied handling; **a "fake agent" fixture adapter registered in the
  test proving a second integration flows through setup without code changes**.
- **Plugin → Core:** simulated event batches against a real Core test server —
  acceptance/dedup/rejection; queue + backoff with Core down; envelope restriction
  (transition-shaped payload → 400).
- **Manual E2E (documented, not CI):** real OpenCode → `opencode mcp list` shows
  `workjournal` connected; plugin appears in `ctx.plugin.list()`.

### 10.10 Documented path for adding future agents (Cline, etc.)

Spec doc `docs/specs/M14-agent-integration.md` includes a how-to: implement
`AgentIntegration` (discovery rules, merge logic for that agent's config format,
validation), declare `capabilities` (mcp-only agents skip the plugin install step),
register in `registry.ts`, add an ingestion `source` mapping if the agent has a
lifecycle plugin mechanism, and add adapter fixtures to the integration suite. The
canonical event schema and ingestion API stay agent-independent — adapters translate
native events into the shared envelope; no setup-CLI or event-model changes required.

### 10.11 Coordination with other workstreams

- **WS-2:** adds `agent_idle` event type; ingestion envelopes reuse the canonical
  schema; nullable `task_id` (§3.1) is required for project-level plugin events.
- **WS-5:** checkpoint-evaluation triggers gain agent signals — `agent_idle`,
  `agent_session_ended` (interrupted/failed/timeout), terminal tool errors.
- **MCP adapter:** small change — forward `_meta["ai.opencode/sessionID"]` with tool
  calls for session↔task correlation.
- **Dashboard/WS-3:** plugin-sourced events appear in the unified timeline via the
  `source` field with no extra UI work.

---

## 11. Migration, Ordering, Tests

### 11.1 Migrations & compatibility

All migrations are additive (new columns default, new tables). Project DB: `002_unified_events.sql`
(category/source columns, nullable task_id, indexes), `003_checkpoint_provenance.sql`.
Registry: `003_prompts.sql`. Embedded-migrations regeneration via
`pnpm --filter @workjournal/core embed` (D-011). Existing rows remain valid; no
breaking API change; 18 existing MCP tools keep identical schemas; SEA and Docker
packaging unchanged. WS-9 adds no DB migration of its own (ingestion reuses the WS-2
envelope; the session↔task correlation map is a small Core-side table added with WS-2)
— its only additive surface is the `workjournal setup` subcommand and the
`/api/ingest/events` route.

### 11.2 Recommended order

1. WS-1 inspect & document current contracts (specs under docs/specs/) — foundation.
2. WS-2 canonical event model (schema, migrations, EventService, agent tools, ingestion
   envelope schemas, session↔task correlation).
3. WS-3 unified history APIs + dashboard timeline.
4. WS-4 checkpoint provenance schema + service.
5. WS-5 deterministic checkpoint policy + evaluation triggers; deterministic content
   assembly only — the optional Compactor provider layer is deferred out of v2
   (D-019); agent-signal triggers land with WS-9.
6. WS-6 MCP resources (reuses Core APIs; depends on WS-2 for enriched history).
7. WS-7 prompt persistence → Core APIs → dashboard CRUD → MCP dynamic registry.
8. WS-8 Core→adapter change bridge + MCP notifications (depends on WS-6/WS-7 targets).
9. WS-9 agent-integration framework + `workjournal setup` + OpenCode plugin +
   `/api/ingest/events`. The setup CLI/config-merge portion only needs WS-1 and can be
   built in parallel with WS-3..WS-8; the plugin and ingestion portions need WS-2
   (envelopes) and WS-5 coordination (signal triggers).
10. WS-10 final integration/recovery/compat tests + comparative benchmarks.

Material deviations: resources (WS-6) precede prompts (WS-7) only because both touch
server-factory and sharing that integration point reduces churn. WS-9 was added after
the original chain was defined; its ordering follows real dependencies — config
discovery/merge is independent of the event model, but plugin event delivery requires
the WS-2 ingestion envelope, so the workstream is split along that seam.

### 11.3 Test plan

- Unit: policy engine cases (warranted/not-warranted matrix), payload schemas, template
  rendering/validation, provenance serialization; integration-registry iteration,
  per-OS config path discovery, JSONC merge/backup/rollback fixtures (WS-9 §10.9).
- Integration: migrations up-from-old-snapshot; idempotent event ingestion; checkpoint
  provenance queries; prompt CRUD + built-in protection + dual-scope shadowing
  resolution; change-stream emission only post-commit; setup CLI from foreign CWDs,
  dry-run, uninstall scope, fake-agent fixture adapter; plugin→Core event
  delivery/dedup/restriction.
- MCP protocol: resources/list + resources/read + completions; prompts/list + prompts/get
  (global and project-resolved); notifications over StreamableHTTP and stdio; existing
  EXPECTED_TOOLS regression.
- UI: prompt editor validation, preview, duplicate, delete guard, scope selector +
  shadow badges (component tests).
- E2E: full agent session → fulfilment → auto-checkpoint → new agent resumes via resource;
  project-scoped prompt edit in dashboard → immediately visible to the project's MCP
  session without rebuild.
- Benchmarks: auto-vs-manual checkpoint recovery fidelity (compaction-provider
  benchmarks deferred with D-019).

---

## 12. Risks, Open Decisions, Recommendations

| Risk | Mitigation |
|------|------------|
| SDK cannot unregister prompts at runtime | render-callback checks current registry; disabled/deleted → explanatory error; document reconnect behavior |
| Notification loss on adapter restart | stateless resources + authoritative refetch on reconnect |
| Policy false positives create noisy checkpoints | conservative defaults, diagnostic events for tuning, config knobs |
| Prompt templates abused for prompt-injection | templates are data-only, secret-filtered, cannot bypass tool authz/version checks |
| Nullable task_id changes existing query assumptions | explicit indexes + integration tests on project-level history |
| SEA embed regeneration forgotten | add embed step to build + CI check |
| OpenCode plugin API/event shapes drift (V2 is young) | spike task verifies event names against the installed OpenCode build before mapping code; unknown events ignored + logged; plugin pins a documented min OpenCode version in its manifest |
| jsonc-parser duplicate-key quirk | report pre-existing duplicates, edit first occurrence only, documented limitation; backup always taken |
| Plugin file stale after WorkJournal upgrade | manifest sha256 check; `setup` re-run refreshes; `--status` flags version mismatch |
| Ingestion endpoint is unauthenticated loopback | same posture as all Core routes (loopback, Zod, payload limits); envelopes restricted to ledger categories — cannot mutate task state even if abused |
| Setup run while OpenCode is running | config is read at OpenCode startup; setup prints restart/reload hint; no live-reload assumption |

**All planning open decisions are now resolved:**

1. **Prompt scope (D-020):** dual-scope — global registry AND per-project prompts in
   one registry table (`project_id` NULL = global). Project rows shadow same-named
   global/built-in prompts for that project only; project scope may also override
   built-ins locally. MCP adapter resolves scope by cwd→registered-project match, with
   a `WORKJOURNAL_PROJECT_ID` env escape hatch.
2. **`agent_tool_call` logging (D-022):** default off; opt-in via plugin option.
3. **Checkpoint evaluation on interruption/timeout:** automatic (§6.2 triggers).
4. **Notification granularity:** per-resource URI (§7.2, §9).
5. **Server-side compaction (D-019):** deferred out of v2 — deterministic checkpoint
   content assembly only; the agent itself supplies the narrative through ledger
   events. `Compactor` interface stays specified for a future release; nothing
   model-related ships now.
6. **Setup framework choices (D-021/D-022):** readline multiselect, global-default
   config scope, embed+extract plugin, jsonc-parser merges.

---

## 13. Final User Workflow Changes

- **One-time setup:** `workjournal setup` from any directory detects OpenCode, shows
  the multiselect, and wires the WorkJournal MCP server + lifecycle plugin into global
  OpenCode config with backups; re-running is a safe no-op; `--status` diagnoses,
  `--uninstall` cleanly removes only WorkJournal entries.
- Agent reports fulfilment/interruption/verification → unified timeline shows both
  WorkJournal and agent ledger events with source and authority badges.
- Lifecycle events (session start/end, interruption, idle) flow automatically from the
  OpenCode plugin to Core — the model never has to invoke tools to record them.
- Auto-checkpoints appear with provenance (trigger event, baseline, source events);
  manual `record_checkpoint` unchanged.
- Agents and users read project/task/resume/history/checkpoint/decision data via
  `workjournal://` resources; all 18 existing tools remain.
- Users create, edit, duplicate, enable/disable and delete prompts from the dashboard at
  **global or per-project scope** — a project prompt shadows a same-named global or
  built-in prompt for that project only; no code edits, no rebuild; the effective
  prompt set is immediately available to that project's MCP sessions.
- Dashboards and MCP clients receive post-commit change notifications; nothing fires
  for failed writes.
- No changes to existing CLI commands, auth, or packaging; `setup` is purely additive.
