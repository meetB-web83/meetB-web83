import { z } from 'zod';

// ============================================================
// WS-3 Event Types and Schemas
// ============================================================

/** WS-3 enhanced event category */
export const EventCategorySchema = z.enum([
  'task',
  'agent',
  'system',
  'security',
  'performance',
]);

export type EventCategory = z.infer<typeof EventCategorySchema>;

/** WS-3 event source identifier */
export const EventSourceSchema = z.string().min(1).max(200);

/** WS-3 project identifier */
export const ProjectIdSchema = z.string().min(1).max(200);

/** Complete WS-3 event recording payload */
export const recordEventPayloadSchema = z.object({
  /** WS-3: Category of the event (task, agent, system, security, performance) */
  category: EventCategorySchema,

  /** WS-3: Source of the event (e.g. 'cline', 'mcp-tool', agent identifier) */
  source: EventSourceSchema,

  /** WS-3: Project ID this event belongs to */
  project_id: ProjectIdSchema,

  /** Optional task ID if the event is task-scoped */
  task_id: z.string().nullable().optional(),

  /** Optional event sequence number (for WS-3 timeline positioning) */
  sequence: z.number().int().optional(),

  /** Cline-specific: the action that triggered this event */
  action: z.string().optional(),

  /** Cline-specific: metadata about the event */
  metadata: z.record(z.unknown()).optional(),

  /** Idempotency key to prevent duplicate event recording */
  idempotency_key: z.string().min(1).max(128),
});

export type RecordEventPayload = z.infer<typeof recordEventPayloadSchema>;

/** WS-3 list events query filters */
export const listEventsQuerySchema = z.object({
  /** Filter by event category */
  category: EventCategorySchema.optional(),

  /** Filter by event source */
  source: EventSourceSchema.optional(),

  /** Filter by project ID */
  project_id: ProjectIdSchema.optional(),

  /** Filter by task ID (null for project-level events) */
  task_id: z.string().nullable().optional(),

  /** Maximum number of events to return (WS-3: limited to 500) */
  limit: z.coerce.number().int().min(1).max(500).default(100),

  /** Offset for pagination */
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

/** Individual event response (WS-3 enriched) */
export const ws3EventResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  sequence: z.number().int(),
  actor: z.string(),
  event_type: z.string(),
  category: EventCategorySchema,
  source: EventSourceSchema,
  created_at: z.string(),
  payload: z.record(z.unknown()),
});

export type Ws3EventResponse = z.infer<typeof ws3EventResponseSchema>;

/** WS-3 timeline event summary for display */
export const ws3TimelineEventSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  sequence: z.number().int(),
  actor: z.string(),
  event_type: z.string(),
  category: EventCategorySchema,
  source: EventSourceSchema,
  created_at: z.string(),
});

export type Ws3TimelineEvent = z.infer<typeof ws3TimelineEventSchema>;

// ============================================================
// Error catalog for plugin operations
// ============================================================

export const pluginErrorSchema = z.object({
  code: z.enum(['SERVICE_UNAVAILABLE', 'VALIDATION_ERROR', 'IDEMPOTENCY_CONFLICT', 'NETWORK_ERROR']),
  message: z.string(),
});

export type PluginError = z.infer<typeof pluginErrorSchema>;

// ============================================================
// API Client for Core Service
// ============================================================

const DEFAULT_CORE_URL = 'http://127.0.0.1:3737';
const DEFAULT_TIMEOUT = 10_000; // 10 seconds

export class WorkJournalApiClient {
  /** Base URL of the core Fastify service */
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || DEFAULT_CORE_URL;
  }

  /** Get the core service URL (respects environment/config) */
  getUrl(): string {
    return this.baseUrl;
  }

/** Check if the core service is reachable */
  async healthCheck(): Promise<{ ok: boolean }> {
    try {
      const url = `${this.baseUrl}/`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return { ok: response.ok };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return { ok: false };
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      return { ok: false };
    }
  }

  /** Record a WS-3 enhanced event */

  /**
   * Record a batch of event envelopes to the core ingestion endpoint.
   * POST /api/events with { events: [{ event_id, event_type, payload, source }] }
   * project_id and task_id are passed as query parameters.
   */
  async recordEvents(
    envelopes: IngestEnvelope[],
    projectId: string,
    taskId?: string
  ): Promise<IngestResult[]> {
    const batch: IngestBatch = { events: envelopes };

    // Validate source format for each envelope
    for (const env of envelopes) {
      if (!SOURCE_REGEX.test(env.source)) {
        throw new Error(`Invalid source format: ${env.source}`);
      }
    }

    const url = new URL(`${this.baseUrl}/api/events`);
    url.searchParams.set('project_id', projectId);
    if (taskId) {
      url.searchParams.set('task_id', taskId);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`Core service responded ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as IngestResult[];
      return data;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Request to core service timed out after ${DEFAULT_TIMEOUT}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Fetch events with WS-3 filters */
  async listEvents(filters: Partial<ListEventsQuery>): Promise<Ws3EventResponse[]> {
    const validated = listEventsQuerySchema.parse(filters);

    const url = `${this.baseUrl}/api/events`;

    const params = new URLSearchParams();
    if (validated.category) params.append('category', validated.category);
    if (validated.source) params.append('source', validated.source);
    if (validated.project_id) params.append('project_id', validated.project_id);
    if (validated.task_id !== undefined) params.append('task_id', validated.task_id ?? '');
    if (validated.limit) params.append('limit', validated.limit.toString());
    if (validated.offset) params.append('offset', validated.offset.toString());

    const fullUrl = params.toString() ? `${url}?${params.toString()}` : url;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    try {
      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`Core service responded ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as Ws3EventResponse[];
      return data;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Request to core service timed out after ${DEFAULT_TIMEOUT}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

/** Ingestion envelope matching backend POST /api/events schema */
export const ingestEnvelopeSchema = z.object({
  event_id: z.string().min(1).max(128),
  event_type: z.string(),
  payload: z.unknown(),
  source: z.string().min(1),
});

export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

export const ingestBatchSchema = z.object({
  events: z.array(ingestEnvelopeSchema).max(50, 'Batch must not exceed 50 envelopes'),
});

export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export const ingestResultSchema = z.object({
  event_id: z.string(),
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  reason: z.string().nullable(),
});

export type IngestResult = z.infer<typeof ingestResultSchema>;

const SOURCE_REGEX = /^[a-zA-Z0-9_.-]+:?$/;

export const CLINE_SOURCE = 'cline';

export function createWorkJournalPlugin(options: {
  projectId: string;
  coreUrl?: string;
}) {
  const client = new WorkJournalApiClient(options.coreUrl);
  const projectId = options.projectId;
  const agentId = `cline_${projectId}`;

  return {
    name: 'workjournal',
    manifest: {
      capabilities: ['hooks'],
    },
    setup(api: any, ctx: any) {
      ctx.logger?.log('workjournal plugin setup', {
        projectId,
        sessionId: ctx.session?.sessionId,
        workspaceRoot: ctx.workspaceInfo?.rootPath,
      });
    },
    hooks: {
      onEvent(event: any) {
        try {
          const envelopes = mapRuntimeEventToEnvelopes(event, projectId, agentId);
          if (envelopes.length === 0) return;

          void client.recordEvents(envelopes, projectId).catch((err: any) => {
            ctx.logger?.error?.('workjournal event ingestion failed', { error: err.message });
          });
        } catch (err: any) {
          ctx.logger?.error?.('workjournal event mapping failed', { error: err.message });
        }
      },
    },
  };
}

export default createWorkJournalPlugin;

/**
 * Map a Cline AgentRuntimeEvent to WorkJournal event envelopes.
 */
function mapRuntimeEventToEnvelopes(
  event: any,
  projectId: string,
  agentId: string
): IngestEnvelope[] {
  const envelopes: IngestEnvelope[] = [];

  const makeEnvelope = (eventType: string, payload: Record<string, unknown>): IngestEnvelope => {
    const eventId = `cline_${eventType}_${projectId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return {
      event_id: eventId,
      event_type: eventType,
      payload,
      source: CLINE_SOURCE,
    };
  };

  switch (event.type) {
    case 'run-started':
      envelopes.push(makeEnvelope('agent_session_started', {
        agent_id: agentId,
        session_id: event.snapshot?.sessionId || 'unknown',
      }));
      break;

    case 'run-finished':
      envelopes.push(makeEnvelope('agent_session_ended', {
        agent_id: agentId,
        session_id: event.snapshot?.sessionId || 'unknown',
        reason: event.result.status === 'completed' ? 'completed' : 'interrupted',
        notes: `Iterations: ${event.result.iterations}`,
      }));
      break;

    case 'run-failed':
      envelopes.push(makeEnvelope('agent_session_ended', {
        agent_id: agentId,
        session_id: event.snapshot?.sessionId || 'unknown',
        reason: 'failed',
        notes: event.error.message,
      }));
      break;

    case 'tool-started':
      envelopes.push(makeEnvelope('agent_tool_call', {
        agent_id: agentId,
        session_id: event.snapshot?.sessionId || 'unknown',
        tool_name: event.toolCall.toolName,
        tool_call_id: event.toolCall.toolCallId,
      }));
      break;

    case 'tool-finished':
      envelopes.push(makeEnvelope('agent_tool_result', {
        agent_id: agentId,
        session_id: event.snapshot?.sessionId || 'unknown',
        tool_name: event.toolCall.toolName,
        tool_call_id: event.toolCall.toolCallId,
        is_error: event.message?.type === 'tool-result' && event.message?.isError === true,
      }));
      break;

    default:
      break;
  }

  return envelopes;
}

export class WorkJournalPlugin {
  private client: WorkJournalApiClient;
  private projectId: string;

  constructor(options: {
    projectId: string;
    coreUrl?: string;
  }) {
    this.projectId = options.projectId;
    this.client = new WorkJournalApiClient(options.coreUrl);
  }

  getClient(): WorkJournalApiClient {
    return this.client;
  }

  getProjectId(): string {
    return this.projectId;
  }

  async recordEvents(
    envelopes: IngestEnvelope[],
    taskId?: string
  ): Promise<IngestResult[]> {
    return this.client.recordEvents(envelopes, this.projectId, taskId);
  }

  async recordEvent(
    eventType: string,
    payload: Record<string, unknown>,
    taskId?: string
  ): Promise<IngestResult[]> {
    const eventId = `cline_${eventType}_${this.projectId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return this.client.recordEvents(
      [{ event_id: eventId, event_type: eventType, payload, source: CLINE_SOURCE }],
      this.projectId,
      taskId
    );
  }

  async listEvents(filters: Partial<ListEventsQuery>): Promise<Ws3EventResponse[]> {
    return this.client.listEvents({
      ...filters,
      project_id: filters.project_id || this.projectId,
    });
  }

  async checkHealth(): Promise<{ ok: boolean }> {
    return this.client.healthCheck();
  }
}