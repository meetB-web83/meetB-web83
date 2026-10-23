# Spec — M5: Checkpoint provenance schema & service (post-MVP)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §5 (WS-4), §6.3 (trigger/content context)
Source of truth: this spec captures plan §5 verbatim where quoted; docs-only, no code or migration files.

## 1. Purpose

Pin the checkpoint-provenance contract so WS-4 implements schema + service changes against a single reviewable reference. Provenance answers: why a checkpoint exists, what triggered it, which events it is built from, and how it relates to the previous checkpoint.

## 2. Migration `003_checkpoint_provenance.sql` (project DB) — plan §5.1

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

- `creation_mode`: `manual` (default, existing `record_checkpoint` behavior) or `auto` (policy-created checkpoints).
- `trigger_event_id`: the event that caused this checkpoint (e.g. the `report_fulfilment` or `task_transitioned` event).
- `previous_checkpoint_id`: links checkpoints into a per-task chain.
- `checkpoint_sources`: relational join table recording which events feed a checkpoint, with role `evidence` \| `trigger` \| `baseline`. Index on `event_id` supports "which checkpoints cite event X".

## 3. Relational join table vs JSON array (plan §5.2)

| | Relational `checkpoint_sources` | JSON `source_event_ids` |
|---|---|---|
| Integrity | FK to append-only events; orphan-proof | none |
| Query "which checkpoints cite event X" | indexed join | JSON scan |
| Write cost | extra rows in same transaction | one column |
| Convention fit | matches relational schema style | `decisions.supporting_event_ids` precedent |

Recommendation: relational table. `decisions.supporting_event_ids` remains as-is (no retro-fit); new decision writes may populate a `decision_sources` table later — out of scope for WS-4.

## 4. CheckpointService changes (plan §5.3)

`createCheckpoint` accepts optional `creation_mode`, `trigger_event_id`, `previous_checkpoint_id`, `source_event_ids[]`. In **one transaction** it:

1. inserts the checkpoint row,
2. inserts `checkpoint_sources` rows,
3. updates `tasks.latest_checkpoint_id`,
4. appends a `checkpoint_recorded` event.

- Idempotency-key dedup prevents double creation from retries (recorded in the same transaction as the state change and its event).
- `getCheckpoint(checkpointId)` returns the checkpoint with its provenance (trigger, sources, previous checkpoint).
- Concurrency: the transaction re-reads `tasks.version` and refuses to describe a newer version than the evidence supports (expected-version check; D-001-style ownership/version discipline applies to state-changing writes — checkpoints themselves do not bump the task version per D-004).

## 5. Verification (docs-only)

- Columns, roles (`evidence` \| `trigger` \| `baseline`), FKs, index, and transaction rules trace to plan §5.1–§5.3.
- `003_checkpoint_provenance.sql` is named exactly as in plan §11.1; no other migration filenames are invented here (exact filename for any session-binding table is a WS-2.5 implementation detail, out of scope).
- git diff for this session contains `docs/specs/*` only.