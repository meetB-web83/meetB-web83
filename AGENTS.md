# AGENTS.md — WorkJournal

WorkJournal is a local-first system that preserves task progress across AI coding-agent sessions, so one agent can stop and another can resume from stored records without the original conversation. Core must be deterministic, inspectable, reliable.

You (the coding agent) build this project end to end. meetb is the only human. Claude was used for planning only and will not write specs or code for you.

## Source of truth

1. `docs/mvp-scope.md` — the MVP Release 1 scope (copy of the "MVP scope" document).
2. **This file's "Decisions overriding the scope doc" section wins over the scope doc.** Where they disagree, follow this file.
3. `docs/decisions.md` — decisions you make yourself (see "Decisions and conflicts").

## Decisions overriding the scope doc

- **No authentication anywhere.** No tokens, sessions, credential init/recovery, credential/session tables, dashboard login, or auth tests/acceptance criteria. Still do: bind to loopback (`127.0.0.1`) by default, Zod validation, payload size limits, secret filtering on exports, no secrets in logs. No Host/Origin checks for now.
- **Storage is per project.** Each project has its own SQLite DB and supporting files in `<project-root>/.workjournal/` (DB, WAL files, exports). That project DB is the source of truth for its tasks, events, checkpoints, decisions and idempotency records.
- **Global registry.** One SQLite DB in the WorkJournal home (`~/.workjournal`, override with `WORKJOURNAL_HOME`) holds only project references (project ID, name, root path) plus its own `idempotency_records` for project-level operations. It is an index, rebuildable by re-registering folders. The project ID is stored in both places; the project DB is authoritative.
- **Project creation, two ways:** an agent calls an MCP tool (`create_project`), or the admin panel calls the API with a project root path, which creates `.workjournal/` and initializes the DB. Initialization is idempotent by root path (already initialized → return the existing project). A missing or moved folder shows as "unavailable" in the admin panel; it must not crash anything.
- **Identity.** Agent IDs are self-declared: `<agent-string>_<project-id>`. At the start of a session, propose your agent string to meetb and wait for confirmation before your first write. Project IDs are a slug of the project name plus a short random suffix (e.g. `oroview-3f9a`), never containing `_`. Validate that an agent ID's suffix matches the target project. The reserved actor `operator` is used by dashboard actions (recovery, task edits) and is exempt from the suffix check.
- **Idempotency.** Keys are unique per project DB. Store key, operation, actor, SHA-256 of the canonicalized validated input (including `expected_version`, excluding the key) and the response. Same key + operation + actor + input hash = equivalent retry: return the stored response, no new state change or event. Anything else with the same key is rejected with `IDEMPOTENCY_KEY_CONFLICT`. Only successful operations are recorded (rejected calls leave no record). The record is written in the same transaction as the state change and its event. Keep records indefinitely in Release 1. Reads need no key.
- **Transport.** One long-running local core service (Fastify on loopback) owns all DB access and serves the dashboard (same origin). The MCP adapter is a thin stdio process that validates input with the shared Zod schemas and forwards to the core service over loopback HTTP. The adapter never opens SQLite. If the service is down, return an actionable error telling the agent to start it; no auto-start in Release 1.
- **Migrations and backups run per project DB**, lazily when the DB is opened, each with its own pre-migration backup. The registry has its own migrations.

## Architecture invariants (do not break)

- All business logic lives in the core service. Dashboard and MCP adapter contain none.
- One domain-level transition function validates every status transition and applies the state update and event record in a single transaction. No other code path changes task status.
- Events are append-only with a per-task monotonic sequence. Never update or delete events.
- Every state-changing operation requires an idempotency key, enforces ownership (current owner) and expected-version checks, and bumps the task version.
- Resume context and handoffs are deterministic: no LLM, explicit `ORDER BY` with tiebreakers, same records → same content and order.
- Timestamps are stored in UTC; only the dashboard converts to local time.
- Parameterized queries only (Drizzle). Escape user content in the dashboard. Pino logs must never contain secrets.
- Shared Zod schemas are the single definition of inputs/outputs for API, MCP adapter and dashboard.

## Do not

- Add authentication or credential storage.
- Let the MCP adapter, dashboard, or any script write to SQLite directly.
- Touch files outside the project's `.workjournal/` folder and the WorkJournal home.
- Silently choose between conflicting instructions (see below).

## Working method

1. **Spec first, per milestone.** Before implementing a milestone (M1–M6 in the scope doc), write its spec yourself under `docs/specs/`: shared contracts (Zod schemas, event payload types, error catalog, handoff schema) first, then the milestone spec with interfaces, file layout and acceptance tests. Nobody will hand you a spec.
2. **Implement against the spec, test as you go.** Vitest with real SQLite files in temp directories. Do not mock the database. Cover the test categories in scope §18 (transitions, concurrency/idempotency, continuity, history/decisions, export, operations) minus anything auth-related, plus the new ones: registry/project-DB consistency, idempotent project init, missing-folder handling, cross-project isolation.
3. **Definition of done for a task:** tests pass, types check, lint clean, docs and `docs/decisions.md` updated, and your state recorded (below).

## Temporary state tracking (until WorkJournal can track itself)

Two MCP servers are available. Use them continuously, at short intervals, not only at the end. Use their tool lists to find the right tools.

**Agent-state MCP** — this project's working state:
- At session start: read current state first (ongoing work, errors, pending items, context file paths). Resume from it instead of re-deriving.
- Write state at each of these moments: you start or claim a task; you make a decision; you finish a test run (pass or fail); you hit an error, blocker, or rate/usage limit; roughly every 10 file edits or 20 minutes of work, whichever comes first; and immediately before you stop or when you think the session may end.
- Shape each entry like a WorkJournal checkpoint so the habit transfers: progress summary, completed work, current findings, unresolved issues, next steps, relevant file paths. Write enough that a different agent could continue without this conversation.

**Codebase memory MCP** — the code map:
- Query it before broad grepping or exploring the repo.
- Update it after structural changes: new package or module, moved/renamed files, new public interfaces or contracts. Do not store transient details.

## Decisions and conflicts

- If the scope doc, this file, or a spec is ambiguous or contradictory, stop that piece of work, record it in the agent-state MCP as an open question, and ask meetb. Do not guess.
- Decisions inside your own domain (spec details, internal structure) go in `docs/decisions.md` with ID, date, decision and reason. If you change one, update the entry; keep the old text noted as superseded.
- Do not alter the "Decisions overriding the scope doc" section yourself. Only meetb changes it.
