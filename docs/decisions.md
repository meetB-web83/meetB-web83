# WorkJournal — Decision Log

Decisions made inside the agent's own domain (root AGENTS.md "Decisions and conflicts").
Format: ID, date, decision, reason. When a decision changes, the entry is updated and the
old text is noted as superseded.

---

## D-001 — Shared contracts carry idempotency keys (2026-10-16)

**Decision.** Every state-changing Zod schema in `packages/shared` requires an
`idempotency_key` (`/^[a-zA-Z0-9_-]{1,128}$/`), and `create_task`/`update_task` require
`agent_id`. The key is excluded from the input hash (root AGENTS.md), enforced
transactionally in `IdempotencyService.run`, and exposed on every MCP write tool.

**Reason.** Root AGENTS.md makes idempotency a hard invariant ("Every state-changing
operation requires an idempotency key"). Putting the requirement in the shared schemas
means the HTTP API, MCP adapter and dashboard cannot drift: a write without a key never
reaches the domain layer.

## D-002 — Claiming runs through the transition function (2026-10-16)

**Decision.** `claim_task` is validated by `canTransition(status → in_progress)`: allowed
from `open` (owner must be NULL) and from `interrupted` (ownership is reassigned to the
recovering agent). No separate claim matrix exists.

**Reason.** Root AGENTS.md: "One domain-level transition function validates every status
transition." Modeling the Agent B recovery claim as `interrupted → in_progress` keeps the
transition table the single source of truth and makes the recovery path (scope §18
continuity) expressible without special cases. The unmodified e2e handoff test passes on
this model.

## D-003 — Domain services own transactions; routes only map input (2026-10-16)

**Decision.** All service methods run inside `IdempotencyService.run`
(`BEGIN IMMEDIATE → check → state → event → record → COMMIT`). HTTP routes do explicit
snake_case → camelCase mapping and per-request project-DB resolution, and must `await`
service calls before `reply.send`.

**Reason.** Two bugs proved the boundary matters: routes originally passed snake_case
input straight into camelCase params (build broke), and un-awaited service calls
serialized Promises as `{}` while rejections escaped as unhandled errors instead of 4xx
responses. Awaiting at the route is now covered by HTTP-layer tests (spec §9.8).

## D-004 — Checkpoint/decision writes do not bump the task version (2026-10-16)

**Decision.** `record_checkpoint`, `record_decision` and `supersede_decision` require the
task to exist and store `expected_version` as the observed version, but they neither
enforce ownership nor bump the task version. They do commit atomically with their
`checkpoint_recorded`/`decision_recorded` event and their idempotency record.

**Reason.** Confirmed with meetb (2026-10-16). Version bumps belong to state transitions;
checkpoints are observational records of the version they observed. Enforcing ownership on
them produced spurious conflicts without adding safety, because they cannot corrupt task
state.

## D-005 — Per-project DB path and registry split (2026-10-16)

**Decision.** Each project's source of truth is `<project-root>/.workjournal/workjournal.db`,
opened lazily by `ProjectDbResolver` (migrations applied per DB, each with its own
pre-migration backup). The global registry (`~/.workjournal/registry.db`) holds only
`registry_projects` rows plus `registry_idempotency`. Git-style root paths (`/c/...`) are
normalised win32-only before filesystem access. Scans for a record never create files;
missing folders read as `unavailable`, never as raw crashes.

**Reason.** Root AGENTS.md overrides: storage is per project, the registry is a rebuildable
index, and a moved folder must not crash anything.

## D-006 — Adapter is a schema-derived thin forwarder (2026-10-16)

**Decision.** MCP tools take their input shapes from `@workjournal/shared` schemas
(`createTaskSchema.shape` etc.), build GET query strings via `buildQueryString` (absent
filters omitted — the original `status=&priority=` bug), and forward to core over loopback
HTTP. Specialised transition tools (`block_task`, `unblock_task`, `cancel_task`,
`mark_task_interrupted`, `complete_task`) fix `target_status` and require
reason/resolution_note at the shape level. The adapter never opens SQLite; if the service
is down it returns an actionable start-it error (no auto-start).

**Reason.** Root AGENTS.md transport and architecture invariants. The `query` builder is
its own module with a subpath export so tests (spec §9.9) can import it without booting
the stdio server.

## D-007 — Review round 2: nav back on top, creation forms as pixel-scrim modals (2026-10-16)

**Decision.** The bottom-dock experiment is reverted: the nav is a sticky top bar with a
2px bottom border again (brand lead, Home/Projects/Docs segments, status tail). Project
and task creation moved from inline forms to centered modals over a pixel-dither scrim
(6px checkerboard mosaic dim) — deliberately no smooth `backdrop-filter: blur()`, which
cannot pixelate. A true content-pixelation of the live page is not possible in pure CSS;
if the dither reads as noise rather than pixelation, the fallback on the table is a
smooth blurred scrim — meetb to judge visually.

**Reason.** Direct review feedback (round 2): bottom nav felt wrong for a tool dashboard;
inline forms pushed content around; smooth blur breaks the neo-brutalist idiom.
Also fixed in the same round: TaskActions renders null on terminal states (the stray
bordered box was an empty `.task-actions` dock), event rows truncate the actor with an
ellipsis instead of overflowing, banner badges are vertically centered, task detail
gains a back-to-project link, filter segments are gapped boxes with centered text, and
the footer uses the nav brand lockup.

## D-008 — Dashboard API shape and paging defaults (2026-10-16)

**Decision.** `GET /api/dashboard` returns `{ stats, recent_tasks, projects }` in one
call; `project_id` is optional and scopes stats + recents while the project list stays
global (unknown id → 404, unavailable folder → 404 with the actionable message).
The default task list limit drops from 100 to 25 (max 500 unchanged). Frontend paging
uses limit+1 (request 26, show 25, 26th row means "next") — no total counts, no
jump-to-page — so the list envelope and MCP contract stay untouched. Projects and
decisions stay unpaginated (agreed: tiny tables).

**Reason.** The home page previously derived stats client-side from a capped fetch, so
both stats and recents would silently go stale past 100 tasks. Server-side `GROUP BY`
counts stay correct at any scale; the scope dropdown reuses the same endpoint instead
of adding per-project fan-out.

## D-009 — Streamable HTTP transport via SDK transport + in-adapter session registry (2026-10-19)

**Decision.** The MCP adapter gains a second transport: Streamable HTTP
(`@modelcontextprotocol/sdk/server/streamableHttp.js`, SDK 1.32.1), selected by
`MCP_TRANSPORT=http` (default remains `stdio`). Both transports build the server via the
same `createMcpServer()` factory so tool names, descriptions, Zod schemas and handlers are
identical by construction. Because SDK 1.32.1 ships no `StreamableHTTPSessionManager`,
the adapter keeps a small session registry (`http-server.ts`): each `initialize` creates
a fresh `McpServer` + `StreamableHTTPServerTransport` pair keyed by the generated session
ID; requests are routed by the `mcp-session-id` header, unknown IDs → 404,
non-initialize without ID → 400, per the MCP Streamable HTTP spec. Endpoint path `/mcp`
on `MCP_PORT` (default 3738), bound to `127.0.0.1`. DNS-rebinding/browser-origin
protection is implemented as external header validation (`validate-headers.ts`) — the
SDK's built-in `allowedHosts`/`allowedOrigins` options are deprecated — plus an optional
`MCP_AUTH_TOKEN` bearer check (off by default; root AGENTS.md: no auth in Release 1).
`/healthz` stays unauthenticated for container health checks.

**Reason.** Docker deployment needs an HTTP MCP endpoint clients can connect to without
spawning a host-side process (release spec §2, §3). Reusing the SDK transport keeps the
protocol implementation official; the thin registry only does session bookkeeping.
Header validation lives in its own module so it is unit-testable without a server, and
the token is opt-in so the loopback-only local-dev model stays frictionless.

## D-010 — Docker distribution: three images, generated release compose via GitHub Releases (2026-10-19)

**Decision.** Three multi-stage images (`workjournal-core`, `workjournal-mcp`,
`workjournal-web`) built from `node:22-alpine`, running as a non-root user, with
`pnpm deploy --prod` for backend runtime stages. The web image serves the built SPA
with `vite preview` and proxies `/api` to `http://core:3737` via `preview.proxy`
(`VITE_CORE_URL`) — no new web server is introduced. Root `docker-compose.yml` builds
from source for development; the distributed artifact is generated at release time
from `docs/release/compose.yaml.template` by `.github/workflows/release.yml` (sed
replaces `__BASE__`/`__VERSION__`), so no registry username is hardcoded in the
repository, and the released `compose.yaml` references published images only (no
`build:`). The release pipeline is verify → images (amd64+arm64) → publish, and
never pushes before tests/builds pass. Core is never published to the host;
published ports bind to `127.0.0.1`; SQLite lives in the `workjournal-data` named
volume at `/data`.

**Reason.** Release spec §3–§6: users must run `docker compose up -d` from a
downloaded compose file with no source checkout, no Node toolchain, and no
host-side MCP process. Template-generation keeps one source of truth while
allowing any OCI registry via repository variables. `vite preview` reuses the
existing frontend toolchain instead of adding nginx (proxy config stays in
`vite.config.ts` alongside the dev proxy). The web image keeps dev dependencies
because `vite preview` itself is a dev dependency — documented tradeoff.

## D-011 — PROJECTS_DIRECTORY, path mapping, and project identity in Docker (2026-10-19)

**Decision.** The core service uses a path-resolution module (`packages/core/src/db/paths.ts`)
that maps host paths (from `PROJECTS_DIRECTORY`) to the container mount point
`/host-projects`. The mapping is bijective and validated at startup: the container
mount must exist, be a directory, and be readable/writable. Registration stores the
**container path** as `root_path` in the registry; the dashboard displays host paths
via reverse mapping. Re-registration is idempotent by normalized container path.
Moving/renaming/deleting a folder on the host leaves the old project `unavailable`
and creates a new project ID for the new location — history stays with the folder.
Per-project `.workjournal/` artifacts live in the project folder itself (via the
bind mount), so backing up the project folder preserves its complete history.

**Reason.** Root AGENTS.md: storage is per project, the registry is an index, and a
missing folder must not crash anything. The path module centralizes all mapping
logic so HTTP routes, MCP tools, and tests share the same behavior. Startup
validation fails fast with actionable Docker Desktop file-sharing guidance. The
identity rule (history follows the folder) matches user expectations and keeps the
registry a rebuildable index.
