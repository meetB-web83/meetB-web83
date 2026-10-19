# Spec — Shared contracts (Release 1 deltas)

Status: accepted
Date: 2026-10-16
Author: mimo (agent), confirmed by meetb

`packages/shared` is the single definition of inputs/outputs for the core API, the MCP
adapter and the dashboard. This spec records the contract changes required to satisfy the
root AGENTS.md invariants (idempotency key on every write, ownership + expected-version
checks) and to make the HTTP layer executable at all. The existing schema files stay the
home of these definitions; nothing here is redefined in the adapter or the dashboard.

## 1. Task schemas (`schemas/task.ts`)

| Schema | Change | Reason |
|---|---|---|
| `createTaskSchema` | add `agent_id: z.string().min(1).max(200)` | §9 requires an actor on the `task_created` event |
| `createTaskSchema` | add `idempotency_key: idempotencyKeySchema` | invariant #4 |
| `updateTaskSchema` | add `agent_id: z.string().min(1).max(200)` | ownership check on owner-controlled mutations (§6) |
| `updateTaskSchema` | add `idempotency_key: idempotencyKeySchema` | invariant #4 |
| `claimTaskSchema` | add `idempotency_key: idempotencyKeySchema` | invariant #4 |
| `releaseTaskSchema` | add `idempotency_key: idempotencyKeySchema` | invariant #4 |
| `transitionTaskSchema` | add `idempotency_key: idempotencyKeySchema` | invariant #4 |
| `listTasksQuerySchema` | `limit`/`offset` become `z.coerce.number().int()` | query params arrive as strings; plain `z.number()` rejects them |

The dashboard sends `agent_id: 'operator'` for writes it performs on the operator's
behalf (reserved actor, exempt from the project-suffix rule per root AGENTS.md).

## 2. Checkpoint and decision schemas

- `createCheckpointSchema`, `createDecisionSchema`, `supersedeDecisionSchema`: add
  `idempotency_key: idempotencyKeySchema`.
- `listCheckpointsQuerySchema`: `limit`/`offset` become `z.coerce.number().int()`.

## 3. Event schemas

- `listEventsQuerySchema`: `limit`/`offset` become `z.coerce.number().int()`.

## 4. Project schemas

- `createProjectSchema`, `updateProjectSchema`: add `idempotency_key: idempotencyKeySchema`.
  Project-level writes are recorded in the registry's own `registry_idempotency` table.

## 5. Event payload contract (new file `types/events.ts`)

```ts
export const EVENT_TYPES = [
  'task_created', 'task_updated', 'task_claimed', 'task_released',
  'task_transitioned', 'checkpoint_recorded', 'decision_recorded',
  'decision_superseded',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
```

Each event type has a payload schema exported as `eventPayloadSchemas: Record<EventType, ZodType>`
and a helper `parseEventPayload(eventType, payload)`. Payloads are validated before the
insert, satisfying "validated event payload" (§9). Every event row carries
`project_id`, `task_id`, a per-task monotonic `sequence`, the `actor` and a UTC
`created_at`.

## 6. Idempotency semantics (unchanged table, clarified contract)

- Key: `idempotencyKeySchema` (`^[a-zA-Z0-9_-]{1,128}$`).
- Input hash: SHA-256 of the canonicalised validated input **including**
  `expected_version` and **excluding** `idempotency_key` (deep key-sorted JSON).
- Same key + operation + actor + hash → replay the stored response; no state change,
  no event.
- Same key with any other operation/actor/hash → `IDEMPOTENCY_KEY_CONFLICT` (409).
- Only successful operations are recorded, in the same transaction as the state change
  and its event. Rejected calls leave no record.

## 7. Error catalog usage (no new codes)

| Situation | Error | Status |
|---|---|---|
| Malformed/absent input, including missing `idempotency_key` | `VALIDATION_ERROR` | 400 |
| Task/project/checkpoint/decision not found | `NOT_FOUND` | 404 |
| `expected_version` mismatch | `STALE_VERSION` | 409 |
| Write by a non-owner on an owned task | `OWNER_MISMATCH` | 403 |
| Claiming a task that already has an owner (status `open`) | `TASK_CLAIMED` | 409 |
| Idempotency key reuse with different input | `IDEMPOTENCY_KEY_CONFLICT` | 409 |
| Transition not permitted by the transition table | `INVALID_TRANSITION` | 422 |
| Project folder missing/unavailable | `NOT_FOUND` with an actionable message | 404 |

Errors must be actionable: an agent reading the message must know what to change.
