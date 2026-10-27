import type { Database } from '../db/connection.js';
import {
  isIngestibleType,
  type IngestEnvelopeInput,
  type IngestBatchResult,
  type IngestEventResult,
} from '@workjournal/shared';
import { EventService } from './event-service.js';
import { SessionBindingService } from './session-binding-service.js';

/**
 * Ledger-only batch ingestion (plan §10.5 / spec M10, decisions D-023, WS-2.4).
 *
 * - Bounded batch (≤50) enforced by the shared ingestBatchSchema.
 * - Task-lifecycle/transition-shaped payloads are rejected at the route with
 *   400; this service re-checks the allowlist defensively (ledger-only even
 *   if the endpoint is abused).
 * - Idempotency is by client-generated event_id: a resend is a no-op
 *   `duplicate`, never a second row (EventService.append owns the dedup).
 * - Per-envelope result (`accepted` | `duplicate` | `rejected` + reason) so a
 *   partial batch never silently drops events.
 * - task_id backfill: envelopes without task_id are bound to the session's
 *   active task (WS-2.5) when the payload carries a session_id; otherwise
 *   they stay project-level (task_id NULL).
 *
 * The single transition function remains the only path that changes task
 * status — nothing in this service writes to `tasks`.
 */
export class IngestService {
  private events: EventService;
  private bindings: SessionBindingService;
  /**
   * WS-5 seam: progress_fulfilment triggers checkpoint *evaluation* (plan
   * §3.5/§6). No-op until the WS-5 policy engine lands; recording the event
   * itself is WS-2's job.
   */
  private onFulfilment: ((taskId: string | null, eventId: string) => void) | null = null;

  constructor(
    private db: Database,
    private projectId: string,
  ) {
    this.events = new EventService(db);
    this.bindings = new SessionBindingService(db);
  }

  /** Wire the WS-5 checkpoint-evaluation hook (no-op seam until then). */
  setFulfilmentHook(hook: (taskId: string | null, eventId: string) => void): void {
    this.onFulfilment = hook;
  }

  ingest(envelopes: IngestEnvelopeInput[]): IngestBatchResult {
    const results: IngestEventResult[] = [];

    // One transaction over the whole batch: accepted events commit together;
    // per-envelope rejections are validation outcomes, not failures, and do
    // not abort the batch.
    this.db.raw.exec('BEGIN');
    try {
      for (const envelope of envelopes) {
        results.push(this.ingestOne(envelope));
      }
      this.db.raw.exec('COMMIT');
    } catch (err) {
      this.db.raw.exec('ROLLBACK');
      throw err;
    }

    return tally(results);
  }

  private ingestOne(envelope: IngestEnvelopeInput): IngestEventResult {
    // Defensive ledger-only guard (D-023); the route already 400s these.
    if (!isIngestibleType(envelope.type)) {
      return {
        event_id: envelope.event_id,
        status: 'rejected',
        reason: `Event type "${envelope.type}" is not ingestible; ingestion accepts ledger signals only.`,
      };
    }

    try {
      const taskId = this.resolveTaskId(envelope);
      const appended = this.events.append({
        projectId: this.projectId,
        taskId,
        actor: envelope.actor,
        source: envelope.source,
        eventType: envelope.type,
        payload: envelope.payload,
        eventId: envelope.event_id,
        occurredAt: envelope.occurred_at ?? null,
      });

      if (envelope.type === 'progress_fulfilment' && !appended.duplicate) {
        this.onFulfilment?.(taskId, appended.id);
      }

      return {
        event_id: envelope.event_id,
        status: appended.duplicate ? 'duplicate' : 'accepted',
        id: appended.id,
        sequence: appended.sequence,
        task_id: taskId,
      };
    } catch (err: any) {
      // Payload schema violation (strict per-type schema) or similar —
      // reported per envelope so the rest of the batch still lands.
      return {
        event_id: envelope.event_id,
        status: 'rejected',
        reason: err?.message || String(err),
      };
    }
  }

  /**
   * Explicit task scope wins; otherwise backfill from the session's active
   * binding — but only when the binding belongs to THIS project (a session
   * never silently leaks events into another project's ledger).
   */
  private resolveTaskId(envelope: IngestEnvelopeInput): string | null {
    if (envelope.task_id) return envelope.task_id;
    const sessionId = extractSessionId(envelope.payload);
    if (!sessionId) return null;
    const binding = this.bindings.resolveActive(sessionId);
    if (binding && binding.projectId === this.projectId) return binding.taskId;
    return null;
  }
}

/** Agent-event payloads carry `session_id` where applicable (M3 §4). */
function extractSessionId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && typeof (payload as any).session_id === 'string') {
    return (payload as any).session_id;
  }
  return null;
}

function tally(results: IngestEventResult[]): IngestBatchResult {
  const accepted = results.filter((r) => r.status === 'accepted').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  return { results, accepted, duplicates, rejected };
}
