# Spec — M2: Durable task records (per-project storage + idempotent writes)

Status: accepted
Date: 2026-10-16
Author: mimo (agent), confirmed by meetb

Covers scope doc §3–§9, §17 and milestone M2, plus the M3 glue needed for the MCP tools
to work end to end. Contracts referenced here are specified in
`docs/specs/shared-contracts.md`.

## 1. Problem being solved

The running core service cannot execute a single task operation:

1. `~/.workjournal/registry.db` contains only `registry_projects` and
   `registry_idempotency`. There is no `tasks`, `events`, `checkpoints`, `decisions` or
   `idempotency_records` table anywhere (`packages/core/migrations/001_initial.sql` is the
   only migration), so every task query fails with `INTERNAL_ERROR`.
2. Root AGENTS.md decides **storage is per project** (`<project-root>/.workjournal/`),
   but `packages/core/src/index.ts` opened only the registry DB.
3. HTTP routes passed validated snake_case input straight into camelCase service
   parameters (`project_id` → `projectId`, …), so `create_task`, `list_tasks`,
   `update_task`, `record_checkpoint` and `record_decision` could not work even with
   tables present. `pnpm build` failed on exactly these calls.
4. No state change ever wrote an event, so history, resume context and handoff exports
   were empty by construction.
5. The MCP adapter always sent `&status=&priority=` on `list_tasks`, which Zod rejects
   (`''` is not a valid enum value).

## 2. Storage design

### 2.1 Registry DB (unchanged role)

`~/.workjournal/registry.db` holds only:

- `registry_projects(id, name, root_path, created_at, updated_at)` — project references.
- `registry_idempotency(...)` — idempotency records for project-level operations.

It is an index; it holds no task data.

### 2.2 Project DB (new)

Path: `<project-root>/.workjournal/workjournal.db`, created lazily on first use.

Created by `packages/core/project-migrations/001_project_init.sql`, applied through the
existing `runMigrations(db, dir)` routine (so each project DB gets its own
`__migrations` ledger and its own `workjournal.db.bak` pre-migration backup):

- `projects(id, name, description, root_path, created_at, updated_at)` — the project row
  is upserted into the project DB on open; **the project DB is authoritative**.
- `tasks`, `events`, `checkpoints`, `decisions`, `idempotency_records`
- Indexes: `tasks(project_id)`, `tasks(status)`, `events(task_id, sequence)`,
  `checkpoints(task_id)`, `decisions(task_id)`.

Foreign keys, WAL and `busy_timeout=5000` come from `createDatabase()`.

### 2.3 `ProjectDbResolver` (`packages/core/src/db/project-db.ts`)

```ts
class ProjectDbResolver {
  constructor(registry: Database, projectMigrationsDir: string);
  forProject(projectId: string): Database;   // registry lookup → open/verify project DB
  forTask(taskId: string): { projectId: string; db: Database };
  forRecord(table: 'checkpoints' | 'decisions', id: string): { projectId: string; db: Database };
  closeAll(): void;
}
```

- Root paths are normalised with `normalizeRootPath()` so the registry's git-style
  `/c/Users/...` form resolves to `C:/Users/...` on Windows.
- Open handles are cached per project id for the process lifetime.
- A registered project whose folder is missing is **unavailable**: reads/writes that need
  it raise `NOT_FOUND` with the resolved path in the message; nothing crashes.
- `forTask` scans registered projects (skipping unavailable ones) and returns the DB that
  contains the task; unknown task ids raise `NOT_FOUND`.

### 2.4 Request scoping

`buildServer()` keeps the registry DB and exposes `server.projectDbs`. Route handlers
resolve the project DB per request and build a per-DB service bundle
(`buildServices(db)`) so services keep their `constructor(db)` shape (tests construct
them directly today and keep working).

## 3. Atomicity and events

- One transaction per state-changing operation: `BEGIN IMMEDIATE` → idempotency check →
  state change → event insert → idempotency record insert → `COMMIT`; any error
  `ROLLBACK`s, leaving neither state change, event nor idempotency record.
- Event types recorded (payloads per `shared/src/types/events.ts`):
  `task_created`, `task_updated`, `task_claimed`, `task_released`,
  `task_transitioned`, `checkpoint_recorded`, `decision_recorded`,
  `decision_superseded`.
- Sequence numbers are assigned inside the transaction as
  `MAX(sequence) + 1` per task.
- `claim`, `release` and `transition` route through the single transition function
  `canTransition()`; a rejected transition raises `INVALID_TRANSITION` (422) and leaves
  the row untouched.

### 3.1 Claim recovery (decision D-005)

`claim_task` validates `canTransition(current, in_progress)`, which allows claims from
`open` **and** `interrupted` (and nothing else). From `open` the task must have no owner
(`TASK_CLAIMED` otherwise); from `interrupted` the previous attempt has ended, so the
claim reassigns ownership to the claiming agent. This is what "Agent B recovers the
interrupted task" means in scope §18 continuity.

## 4. Checkpoints and decisions

Ownership/expected-version enforcement and version bumping for `record_checkpoint`,
`record_decision` and `supersede_decision` are **explicitly deferred by meetb**
(2026-10-16): these operations keep today's behaviour (task must exist; `expected_version`
is stored as the checkpoint's `task_version`) and additionally record their event in the
same transaction. Recorded as decision D-004 in `docs/decisions.md`.

## 5. HTTP layer

Each route maps snake_case validated input to camelCase service arguments explicitly —
no implicit pass-through. Task-scoped routes resolve the DB via `forTask`, checkpoint/
decision/event/resume/export routes likewise; project-scoped routes use `forProject`.

`GET` list endpoints pass coerced numeric `limit`/`offset`.

## 6. MCP adapter

- Tools use the **shared Zod schemas** as their input shape (`schema.shape`), so the
  adapter cannot drift from the API contract (root AGENTS.md: shared schemas are the
  single definition).
- `list_tasks` builds its query with `URLSearchParams`, omitting absent filters (fixes
  the empty-enum 400).
- `get_task_history` passes `limit`/`offset` only when supplied.

## 7. Dashboard writes

`ProjectsPage`, `ProjectDetailPage` and `TaskActions` attach
`idempotency_key: crypto.randomUUID()` to every write, and `agent_id: 'operator'` where
the contract requires an actor. The dashboard performs no other contract work.

## 8. File layout

```
packages/core/
  migrations/001_initial.sql              (registry, unchanged)
  project-migrations/001_project_init.sql (new, project DB)
  src/db/project-db.ts                    (new: resolver + path normalisation)
  src/db/connection.ts                    (unchanged)
  src/index.ts                            (library barrel)
  src/main.ts                             (service bootstrap)
  src/http/routes/*.ts                    (input mapping + db resolution + idempotency)
  src/domain/*-service.ts                 (transaction + event + idempotency)
  src/domain/idempotency.ts               (new: hash + runIdempotent helper)
packages/shared/src/types/events.ts       (new: event types + payload schemas)
packages/mcp-adapter/src/tools/register.ts(shared schemas + query building)
```

## 9. Acceptance tests (Vitest, real SQLite in temp dirs)

1. **Storage** — using a project whose root is a temp dir creates
   `<root>/.workjournal/workjournal.db` with all six tables; a second open is idempotent;
   a project whose folder was deleted reports unavailable instead of throwing raw errors.
2. **Registry/project consistency** — the project row exists in both DBs and the project
   DB copy is authoritative after a rename.
3. **Transitions** — every allowed transition accepted, every rejected one raises
   `INVALID_TRANSITION` and leaves row + history unchanged.
4. **Concurrency/idempotency** — two simultaneous claims produce one owner; stale
   versions rejected; equivalent retry with the same key returns the stored response and
   creates no second event; conflicting reuse → 409.
5. **Transactional consistency** — a forced failure mid-operation leaves neither task
   state change nor event.
6. **Continuity** — Agent A create → claim → checkpoint → decision → interrupt, Agent B
   recovery claim → resume context contains objective, completed work, active decisions,
   unresolved issues and next steps (existing e2e test, unmodified).
7. **History/decisions** — chronological ordering, supersession preserves both records,
   superseded decisions excluded from resume context.
8. **HTTP layer** — `create_task`/`list_tasks`/`record_checkpoint` round-trip through
   Fastify `inject`, including the string-coerced query params.
9. **Adapter** — `list_tasks` omits absent filters from the query string.

Definition of done: `pnpm build`, `pnpm typecheck`, `pnpm test` green; docs and
`docs/decisions.md` updated; demo data seeded through the MCP tools.
