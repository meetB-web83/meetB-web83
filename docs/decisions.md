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

## D-012 — Single executable via Node SEA; generated embed files are committed (2026-10-19)

**Decision.** Release 1 ships a second distribution alongside Docker: a single
Node SEA executable built by `pnpm build:exe` (`backend/scripts/build-exe.ts`)
into `dist-bin/workjournal(.exe)`, verified by `pnpm smoke:exe`
(`backend/scripts/smoke-exe.ts`: `--version`, `start --with-ui` serving UI +
`/health` + `/api` on one port, `mcp` stdio handshake, `stop`). Specifically:

- **Generated embed files are committed** (`embedded-ui.generated.ts`,
  `embedded-migrations.generated.ts`; codegen chained into core's `embed`/`build`
  scripts), so a fresh clone typechecks and builds without running codegen or a
  frontend build first. ESLint ignores `**/*.generated.ts`.
- **Migrations have two sources** (`db/migrations-source.ts`): the `.sql`
  directory on disk when it exists (dev/Docker byte-identical to before),
  otherwise the embedded arrays; `runMigrations` takes `string | MigrationFile[]`
  and every caller goes through the resolver — no caller computes its own path
  from `import.meta`.
- **The bundle is one CommonJS file** produced by esbuild from the tsc-built
  `packages/cli/dist/standalone.js` (shared commander program in `program.ts`;
  no top-level await anywhere in its graph — the adapter's TLA `index.ts` stays
  out of it). `import.meta.dirname` is a build `define` set to `undefined`, so
  `migrations-source.ts` falls through to the embedded arrays inside the binary
  (and any other `import.meta` use still warns + must be fixed); `node:sqlite`
  loads via `process.getBuiltinModule('node:sqlite')` instead of
  `createRequire(import.meta.url)`, raising `engines.node` to `>=22.3.0`.
- **SEA assembly** follows the Node docs: sea-config → blob → copy of
  `process.execPath` → postject (`NODE_SEA_BLOB` + sentinel fuse
  `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`). The optional signature
  remove/re-sign steps ("refreeze") are skipped with a log line when `signtool`
  is absent (normal on this machine); postject's "signature seems corrupted"
  warning about node.exe's stale Authenticode signature is then expected and
  harmless. `dist-bin/` is gitignored (rebuildable artifact).
- `backend/scripts/` is typechecked (`tsc -p scripts/tsconfig.json`) and linted
  by the root `typecheck`/`lint` scripts; `backend/package.json` gained
  `"type": "module"` so those scripts are ESM under Node16 resolution.

**Reason.** Task 5d3a1793 (Phase 2): users must run WorkJournal with no Node
install and no source checkout. Committing the generated embed files keeps the
"fresh clone builds" property that Docker/dev already rely on, while letting the
SEA binary read migrations and the dashboard without any files next to it —
`migrations-source.ts` picks disk vs. embedded from what actually exists, so the
same `.sql` inputs produce the same `__migrations` ledger in every packaging
mode. The `getBuiltinModule` switch exists because esbuild empties `import.meta`
under the CJS output format the SEA requires; the explicit `define` documents
the one intentional `import.meta` use instead of hiding the warning. Note: the
task's acceptance criteria said "D-011", but that ID was taken by the Docker
path-mapping decision; recorded as D-012 with meetb's agreement (2026-10-19).

## D-013 — MCP self-starts the core (autostart) and stops it last-one-out (2026-10-21)

**Decision.** The stdio MCP adapter starts the core service itself when it is
down, and an auto-started service stops itself once no client remains.
Supersedes the root AGENTS.md "no auto-start in Release 1" rule — the rewrite
was explicitly authorized by meetb in-session (2026-10-21), along with these
settled parameters:

- **Autostart is on by default for stdio.** `workjournal mcp` probes
  `GET {WORKJOURNAL_CORE_URL}/health`; if it fails, it spawns a DETACHED
  `start [--with-ui]` (env `WORKJOURNAL_AUTOSTART=1`), logging to
  `<home>/service.log`, and polls `/health` for `MCP_AUTOSTART_TIMEOUT_MS`
  (default 10s) before serving. `mcp --no-autostart` / `MCP_AUTOSTART=0`
  restore the previous fail-with-an-actionable-error behavior; a healthy
  service is always attached to without restarting (the one exception:
  D-014's `--with-ui` override below). `mcp --with-ui` is the
  whole UI toggle (it rides on the MCP server command line in
  `opencode.json`); if the already-running core lacks the dashboard, the
  adapter attaches and prints a stderr note instead of restarting (no
  downtime for concurrent agents) *(superseded in part by D-014: with
  `--with-ui` that UI-less core is now stopped and replaced; this note
  remains as the guard-rail fallback, and plain `mcp` still attaches
  without restarting)*.
- **Spawn target** (`mcp-adapter/src/autostart.ts`): the SEA executable
  re-runs ITSELF (basename `workjournal(.exe)`, as produced by
  `pnpm build:exe`) — the no-Node path. Source/dev runs (`node`/`tsx` …)
  cannot re-launch themselves safely, so they need `MCP_AUTOSTART_ENTRY`
  (path to the CLI entry) and otherwise warn and fail actionably. Tests use
  the entry form; Docker/HTTP mode never autostarts (the core is a separate
  container with its own healthcheck).
- **Heartbeat + last-one-out auto-stop.** Every stdio adapter writes
  `<home>/mcp-heartbeats/<pid>.json`, touches it every
  `MCP_HEARTBEAT_SECONDS` (default 30s), unlinks it on orderly exit
  (stdin close, SIGINT/SIGTERM, process exit), and unrefs its timer so the
  heartbeat never keeps the process alive. A core started with
  `WORKJOURNAL_AUTOSTART=1` runs a sweeper (`core/src/runtime/idle-sweeper.ts`)
  polling every `AUTO_STOP_POLL_SECONDS` (default 60s): no heartbeat file
  fresh within `AUTO_STOP_FRESH_SECONDS` (default 90s) for
  `AUTO_STOP_IDLE_SECONDS` (default 300s = the 5-minute window meetb chose,
  at 1-minute polls, instead of 10) → close the server, remove `service.pid`,
  exit 0. Hard-killed adapters leave stale files that age out of the fresh
  window, so a crash still releases the service (exercised for real on
  Windows, where `child.kill()` skips signal handlers). The sweeper is
  **gated on the flag**: manually started services and Docker are never
  auto-stopped — only `workjournal stop` ends those.
- **Two lifecycle fixes found on the way:** (1) `start` now writes the PID
  file only AFTER a successful `listen` and answers `EADDRINUSE` with an
  actionable message — two adapters racing to autostart resolve to one
  service with an intact PID file (the loser exits without clobbering it);
  (2) `stop` (and `start`) resolve `~/.workjournal` via `workjournalHome()`
  (`HOME`/`USERPROFILE` expansion) — previously `stop` resolved the raw `~/…`
  against the CWD and could never find the PID file with the default env.
  The CLI entry also switched from `parse()` to `parseAsync().catch(…)` so
  async action failures exit deterministically with code 1.

**Reason.** meetb wants an agent's MCP connection to bring the whole process
up with it — zero manual steps before tools work — with the dashboard
available simply by adding `--with-ui` to the MCP command. Detached (not a
child) spawn is required: WorkJournal exists to preserve continuity across
agent sessions, so the service must outlive them. Symmetry was then required
back: "if it is auto starting it should auto stop" — hence last-one-out with
an idle window, so nothing lingers after the last agent while manually
started services keep their explicit lifecycle. The flag gate keeps Docker
and manual runs byte-identical to before; tests cover the autostart,
heartbeat keep-alive, auto-stop, both guard rails, the UI-conflict note and
the manual-start exemption (`tests/integration/mcp-autostart.test.ts`,
`idle-sweeper.test.ts` — suite green at 111 tests), and `pnpm smoke:exe`
verifies the same flow against the actual executable.

## D-014 — `mcp --with-ui` replaces a running core that lacks the dashboard (2026-10-21)

**Decision.** When the stdio adapter serves `--with-ui` against an
ALREADY-HEALTHY core whose `GET /` is not dashboard HTML, it stops that core
and spawns a `--with-ui` replacement — superseding D-013's "attach and print
a note instead of restarting" bullet (the note survives as the guard-rail
fallback below). Scope choices confirmed by meetb in-session (2026-10-21):

- **Any origin counts.** The running core is replaced whether it was started
  by hand (`workjournal start`) or by another adapter — meetb explicitly
  chose "any core without the UI", carving out the root AGENTS.md rule that
  manually started services are never auto-stopped, and accepting that a
  manual core is thereby replaced by an AUTO-STARTED one to which
  last-one-out then applies (it disappears 5 minutes after the last MCP
  client leaves, unlike the manual core it replaced). Cores with no local
  `service.pid` (Docker/remote) cannot be identified and are never touched.
- **`--no-autostart` / `MCP_AUTOSTART=0` disables the override** (attach +
  note stays): the flag promises to keep this adapter off the core's
  lifecycle, and a restart is both a stop and a start.
- **Guard rails degrade to attach-and-note, never to failure:** no spawn
  target in this runtime (source run without `MCP_AUTOSTART_ENTRY`), no
  readable `<home>/service.pid`, or the kill not taking effect. An MCP
  session that can attach always serves.
- **Kill sequence:** SIGTERM (the POSIX core closes cleanly; Windows
  terminates either way) → poll `/health` until the fetch FAILS, meaning the
  listener closed and the port is free for the replacement (the EADDRINUSE
  barrier) → SIGKILL + one more wait if it still answered after 8s → remove
  the stale `service.pid` only if it still names the killed PID (never
  clobber a racing adapter's replacement PID file) → the existing detached
  spawn (`start --with-ui`, `WORKJOURNAL_AUTOSTART=1`, `service.log`,
  `MCP_AUTOSTART_TIMEOUT_MS` health wait). Concurrent `--with-ui` adapters
  racing resolve the same way as the original autostart race: `ESRCH` on the
  kill counts as already-done, the loser's spawn hits `EADDRINUSE` and exits
  without clobbering the winner's PID file.
- **Consequences:** other clients see a brief gap (in-flight calls fail;
  later calls transparently hit the replacement on the same URL; an open
  dashboard tab needs a refresh). If the replacement never comes up after
  the kill (port stolen in the gap, missing embedded assets), the adapter
  fails with the standard actionable error + log path — it cannot fall back,
  because the old core is already gone.

**Reason.** meetb wants `--with-ui` on the MCP command line to be the whole
UI switch: adding it to `opencode.json` should bring the dashboard up even
when an earlier session (or the user) left an API-only core running — no
manual `workjournal stop` first. The change lives entirely in
`mcp-adapter/src/autostart.ts` (`ensureDashboard`, `stopRunningCore`,
`spawnCoreDetached`); `service.pid` stays a plain-integer file — no format
change is needed once the scope is "any core". Tests:
`tests/integration/mcp-autostart.test.ts` §3 was rewritten into four cases
(replacement end-to-end incl. last-one-out of the replacement, the
`--no-autostart` opt-out, no-restart when the dashboard is already served,
missing-PID-file fallback) — suite green at 114 tests, typecheck and lint
clean.

## D-015 — `status` and the MCP attach log report the current PID (2026-10-21)

**Decision.** `workjournal status` prints the PID of the running core next
to the reachability line — `WorkJournal core service is running at
http://127.0.0.1:3737 (pid 29172)` — read from `<home>/service.pid` and
cross-checked with `process.kill(pid, 0)` (EPERM counts as alive, ESRCH as
gone). The HTTP probe stays the source of truth for liveness; the PID only
decorates whichever branch the probe falls in, and the two PID-file
mismatch cases are called out instead of being silently glossed over:

- running + stale PID file → `(stale service.pid: pid N is not running)`;
- running + no PID file (foreign/Docker core) →
  `(no service.pid in <home> — pid unknown)`;
- not running + PID file present → a second line says whether that PID is
  stale (`no longer exists`) or alive-but-not-answering (still starting up,
  or the PID belongs to another process).

**Addition, same session:** the stdio adapter also logs what it joins —
every time it attaches to an ALREADY-RUNNING core it writes
`connecting to existing core running at http://127.0.0.1:3737 (pid: 29172)`
to stderr before any D-014 decision follows (stdout stays reserved for the
JSON-RPC stream). The number is printed only when `<home>/service.pid` names
a live process — otherwise the line says `(pid: unknown)`, so a stale file
never makes the log lie. Implemented in `mcp-adapter/src/autostart.ts`
(`ensureCore`'s healthy branch + `describeLocalPid`).

Requested by meetb (2026-10-21) as a monitoring aid, after he asked whether
`status` shows the PID (it didn't — it was a bare HTTP probe that never
opened the file). CLI-only: `packages/cli/src/commands/status.ts` uses the
existing `readPidFile`/`workjournalHome()` helpers; no core/DB involvement
and `stop` is unchanged. Tests: `tests/integration/cli-status.test.ts`
(5 cases — pid on the running line, stale-while-running,
pid-unknown-while-running, stale-while-down, alive-but-unreachable) plus the
attach-log assertions in `mcp-autostart.test.ts` §3 (pid on attach,
`(pid: unknown)` fallback) — suite green at 119 tests, typecheck and lint
clean.
