# WorkJournal — MVP Release 1

**Release:** 1 — Prove Continuity Works  
**Status:** Scoped implementation specification

## 1. Objective

Build a local-first system that preserves task progress across AI coding-agent sessions. One agent must be able to record progress, end its session, and allow another agent to resume the task using WorkJournal's stored records and generated handoff, without depending on the original conversation.

The core system must be deterministic, inspectable, and reliable.

## 2. Technology Stack

- **Runtime:** Node.js LTS with TypeScript.
- **API:** Fastify.
- **Database:** SQLite as the single source of truth.
- **Database access:** Drizzle ORM with schema migrations.
- **Validation:** Zod.
- **Agent integration:** Official MCP TypeScript SDK.
- **Dashboard:** React, Vite, and TypeScript.
- **Testing:** Vitest.
- **Logging:** Pino.
- **Package management:** pnpm workspace.

## 3. Core Service and Database

- Implement one local core service that owns all business logic and database operations.
- Use one SQLite database shared by the dashboard and MCP adapter.
- Configure SQLite transactions, foreign keys, WAL mode, and an appropriate busy timeout.
- Implement schema migrations and stable identifiers for persistent records.
- Store timestamps consistently in UTC.
- Use structured logging with sensitive values excluded.
- Ensure task-state updates and their corresponding event records are committed atomically.

## 4. Projects and Task Management

Implement project and task CRUD operations.

Each project must have:

- Stable project ID.
- Name and description.
- Creation and update timestamps.

Each task must have:

- Stable task ID and project ID.
- Title and objective.
- Acceptance criteria.
- Priority and status.
- Current owner, when claimed.
- Version number.
- Creation and update timestamps.
- Latest checkpoint reference, when available.

Provide operations to create, retrieve, update, and list projects and tasks. Support filtering tasks by project, status, and priority.

Keep each project's tasks and history independently associated with that project.

## 5. Task Lifecycle

Implement the following explicit task statuses:

- `open` — available to be claimed.
- `in_progress` — actively being worked on.
- `blocked` — progress depends on an unresolved condition.
- `interrupted` — the current attempt ended without confirmed completion.
- `completed` — work has been reported complete.
- `cancelled` — work has been intentionally stopped.

Implement these transitions:

| Current status | Allowed next status                                        |
| -------------- | ---------------------------------------------------------- |
| `open`         | `in_progress`, `cancelled`                                 |
| `in_progress`  | `open`, `blocked`, `completed`, `cancelled`, `interrupted` |
| `blocked`      | `open`, `cancelled`                                        |
| `interrupted`  | `in_progress`, `open`, `cancelled`                         |
| `completed`    | Terminal                                                   |
| `cancelled`    | Terminal                                                   |

Require a reason for cancellation, blocking, and interruption. Record a resolution note when unblocking a task.

Implement one domain-level transition function that validates every transition and applies the associated state update and event record in a single transaction.

## 6. Task Claims and Concurrency Safety

- Implement atomic task claiming so only one competing agent can claim a task successfully.
- Associate each active claim with an agent identifier.
- Require the current owner for owner-controlled task mutations.
- Maintain a monotonically increasing task version for accepted updates.
- Require expected-version checks for updates based on previously retrieved task state.
- Reject stale writes and unauthorized ownership changes.
- Implement explicit release and recovery operations.
- Support operator recovery of interrupted tasks.
- Require an idempotency key for every state-changing operation.
- Return the original result for an equivalent retry.
- Reject conflicting reuse of an idempotency key.
- Test simultaneous claims, stale updates, ownership enforcement, and retry behavior.

## 7. Checkpoints

Implement checkpoint creation and retrieval.

Each checkpoint must record:

- Checkpoint ID and task ID.
- Timestamp and associated task version.
- Progress summary.
- Completed work.
- Current findings.
- Unresolved issues.
- Next steps.
- Relevant file paths or references, when provided.

Preserve earlier checkpoints so task progress can be inspected over time.

A checkpoint must provide enough information for a different agent to continue without relying on the previous conversation.

## 8. Decisions

Implement decision recording and retrieval.

Each decision must include:

- Decision ID and associated task ID.
- Decision statement.
- Rationale.
- Creation timestamp.
- Optional alternatives.
- Optional supporting event references.
- Decision status.

Implement decision supersession by recording a replacement decision and linking it to the previous decision. Preserve both records and clearly identify which decision is currently active.

Include active decisions in resume context and retain superseded decisions in task history.

## 9. Append-Only Event History

Record meaningful task and workflow actions in an append-only event history.

Each event must contain:

- Event ID.
- Project ID and task ID.
- Monotonically ordered sequence number within the task.
- Timestamp.
- Actor or agent identifier.
- Event type.
- Validated event payload.

Record task creation and updates, claims, releases, state transitions, checkpoints, decisions, decision supersession, failures, interruptions, and relevant handoff actions.

Ensure every accepted state-changing operation and its associated event are committed together. Provide chronological history queries for individual tasks.

## 10. Deterministic Resume Context

Implement a core operation that compiles resume context from the task's stored state, checkpoints, decisions, and events.

The generated context must contain these sections in a stable order:

1. Task identity, objective, acceptance criteria, status, priority, and version.
2. Latest checkpoint and next steps.
3. Active decisions in chronological order.
4. Completed work and current findings.
5. Unresolved issues and failures.
6. Relevant events recorded since the latest checkpoint, or all relevant events when no checkpoint exists.

Ensure that the same stored records produce the same context content and ordering.

Include stable identifiers and enough information to trace context items back to their source records.

Implement a configurable-in-code context size limit. When truncation is required, remove older low-priority informational events first and explicitly indicate that truncation occurred. Preserve the latest checkpoint, active decisions, unresolved issues, and next steps.

The resume-context builder must use deterministic application logic without requiring an LLM.

## 11. MCP Adapter

Implement a local MCP adapter using the official MCP TypeScript SDK. Route all operations through the shared core service.

Provide these tools:

- `create_task`
- `get_task`
- `list_tasks`
- `update_task`
- `claim_task`
- `release_task`
- `block_task`
- `unblock_task`
- `complete_task`
- `cancel_task`
- `mark_task_interrupted`
- `record_checkpoint`
- `record_decision`
- `supersede_decision`
- `get_task_history`
- `get_resume_context`
- `export_handoff`

Validate all inputs and enforce authentication, ownership, version, and idempotency rules for applicable operations.

Return structured responses and actionable errors so coding agents can recover from rejected operations.

Verify that multiple MCP clients connected to the same service observe the same task state and history.

## 12. Dashboard

Implement a local React/Vite dashboard backed by the core API.

Provide the following views and actions:

- Project list and project task list.
- Task creation and editing.
- Task list filtered by status and priority.
- Task detail showing objective, acceptance criteria, status, priority, owner, and version.
- Checkpoint and next-step inspection.
- Decision history with superseded decisions clearly identified.
- Chronological task event history.
- Lists of blocked and interrupted tasks.
- Operator actions for task recovery.
- Resume-context viewing and copying.
- JSON and `HANDOFF.md` export actions.

Render timestamps in the browser's local time zone while storing them consistently in UTC.

Use the same domain rules and authorization checks as MCP operations.

## 13. JSON Handoff Export

Implement a versioned JSON handoff format containing:

- Format version and export timestamp.
- Project and task identifiers.
- Task objective, acceptance criteria, current status, priority, owner, and version.
- Latest checkpoint and next steps.
- Active and superseded decisions.
- Relevant event history.
- Unresolved issues and failures.
- Stable record identifiers and timestamps.

Validate the generated document against its schema before returning or saving it.

Apply baseline secret filtering to exported content. Treat agent-provided text and event payloads as untrusted input. Ensure export operations do not expose local credentials or authentication tokens.

Document the export schema so another compatible tool can consume it.

## 14. `HANDOFF.md` Generation

Generate a readable Markdown handoff from the same underlying task records.

Include:

- Task objective and current status.
- Acceptance criteria.
- Completed work.
- Current findings and relevant file references.
- Active decisions and their rationale.
- Constraints and unresolved issues.
- Latest checkpoint.
- Recommended next steps.
- Relevant repository assumptions when available.

Keep the output understandable to a human or an AI coding agent that has not seen the original conversation.

Clearly distinguish stored task information from claims that have not been independently verified.

Ensure JSON and Markdown handoffs agree on the task's current state and essential continuity information.

## 15. Local Authentication and Security

- Bind the core service to loopback by default.
- Require authentication for dashboard access and state-changing operations.
- Implement a documented local credential initialization and recovery process.
- Protect credential and session data using appropriate local storage and file permissions.
- Validate all API and MCP inputs with Zod schemas.
- Apply sensible request and payload size limits.
- Use parameterized database operations.
- Escape user-provided content when rendering it in the dashboard.
- Exclude credentials and tokens from application logs, error messages, and exports.
- Implement baseline secret-pattern filtering for generated handoffs.
- Return consistent errors without exposing sensitive implementation details.

## 16. Backup and Restore

- Implement a documented manual SQLite backup procedure.
- Use SQLite's supported backup mechanism or a safe shutdown-and-copy process.
- Implement and document database restoration.
- Create a pre-migration backup before applying migrations to an existing database.
- Test backup and restore using a separate database copy.
- Verify that restored projects, tasks, checkpoints, decisions, and events remain consistent.

## 17. Minimum Data Model

Implement the following tables or equivalent persisted structures:

- `projects`
- `tasks`
- `events`
- `checkpoints`
- `decisions`
- `idempotency_records`
- Local credential/session records required by the selected authentication design.

Use foreign keys, appropriate indexes, schema constraints, and migrations. Index task listing by project and status, and event history by task and sequence number.

## 18. Testing Requirements

Implement automated tests using Vitest.

**State transitions**

- Verify every allowed transition.
- Verify every rejected transition.
- Verify that invalid transitions leave the database unchanged.

**Concurrency and idempotency**

- Verify that simultaneous claims cannot produce two accepted owners.
- Verify that stale versions are rejected.
- Verify that unauthorized writes are rejected.
- Verify that equivalent retries do not duplicate effects.
- Verify that conflicting idempotency-key reuse is rejected.
- Verify transactional consistency between task state and event history.

**Continuity**

- Create a task and claim it as Agent A.
- Record progress, a decision, and a checkpoint.
- Mark the task interrupted.
- Recover and claim the task as Agent B.
- Generate resume context.
- Verify that Agent B can identify the objective, completed work, active decisions, unresolved issues, and next steps without the original conversation.

**History and decisions**

- Verify chronological event ordering.
- Verify checkpoint preservation.
- Verify decision supersession without deleting prior decisions.
- Verify superseded decisions are excluded from the active-decision section of resume context.

**Export**

- Validate JSON against its declared schema.
- Verify required continuity fields in both JSON and Markdown.
- Verify that unchanged source records produce equivalent handoff content.
- Test secret filtering with seeded credentials and token-like strings.

**Operations and security**

- Verify loopback binding configuration.
- Verify unauthenticated state-changing requests are rejected.
- Verify input validation and payload limits.
- Verify credentials do not appear in logs or exports.
- Verify backup and restore preserve database integrity.

## 19. Implementation Milestones

### M1 — Foundation

- Initialize the pnpm workspace and application structure.
- Configure TypeScript, Fastify, SQLite, Drizzle, Zod, Vitest, and Pino.
- Implement migrations, project/task schemas, and the task transition engine.
- Implement baseline local authentication.

### M2 — Durable task records

- Implement task CRUD, claims, releases, ownership checks, and version protection.
- Implement idempotency handling.
- Implement event history, checkpoints, and decisions.
- Add transactional integration tests.

### M3 — MCP integration

- Implement the scoped MCP tools.
- Route all tools through shared domain operations.
- Test concurrent clients against the same database.

### M4 — Resume and handoff

- Implement deterministic resume-context generation.
- Implement versioned JSON export.
- Implement `HANDOFF.md` generation.
- Add secret filtering and handoff-integrity tests.

### M5 — Dashboard and recovery

- Implement project and task views.
- Add task history, checkpoint and decision inspection, and recovery controls.
- Add resume-context viewing and export actions.

### M6 — Hardening and validation

- Complete concurrency, idempotency, transition, and continuity tests.
- Implement and test backup/restore.
- Verify authentication, input validation, and export filtering.
- Run the end-to-end continuity scenario from a clean installation.
- Document setup, MCP configuration, local authentication, backup, restore, and known limitations.

## 20. Release Acceptance Criteria

Release 1 is ready when:

1. An agent can create a task, claim it, record progress, and checkpoint that progress.
2. An interrupted task can be recovered without losing previously committed records.
3. A second agent can claim the task and reconstruct its working context without the original conversation.
4. Concurrent claims and stale writes cannot silently corrupt task ownership or state.
5. Retried writes do not create duplicate state changes or events.
6. Task changes and event history remain transactionally consistent.
7. Resume context is deterministic and preserves essential continuity information.
8. JSON and `HANDOFF.md` exports contain the required task state and next steps.
9. Export filtering removes seeded high-confidence secrets.
10. The dashboard provides task inspection and recovery.
11. Authentication protects state-changing operations.
12. Backup and restore preserve the integrity of stored records.
13. The automated test suite passes for transitions, concurrency, idempotency, continuity, exports, and recovery.

## 21. Primary Success Measure

The primary measure is a repeatable handoff:

**Agent A records meaningful progress → Agent A's session ends → WorkJournal preserves the state → Agent B retrieves the handoff → Agent B continues without needing the original conversation.**

Release 1 is successful when this flow works reliably and its integrity can be demonstrated through automated tests.
