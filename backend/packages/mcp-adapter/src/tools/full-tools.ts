import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import {
  createTaskSchema,
  updateTaskSchema,
  claimTaskSchema,
  releaseTaskSchema,
  blockTaskSchema,
  cancelTaskSchema,
  interruptTaskSchema,
  unblockTaskSchema,
  completeTaskSchema,
  listTasksQuerySchema,
  createCheckpointSchema,
  createDecisionSchema,
  supersedeDecisionSchema,
  listEventsQuerySchema,
  dashboardQuerySchema,
  projectIdFromAgentId,
  ValidationError,
  type IngestEnvelopeInput,
} from '@workjournal/shared';
import { callCore } from '../client.js';
import { buildQueryString } from './query.js';
import { extractSessionId } from './session-meta.js';

type Json = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const asJson = (result: unknown): Json => ({
  content: [
    { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
  ],
});

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function registerFullTools(server: McpServer, coreUrl: string, projectId?: string) {
  const tool = (
    name: string,
    description: string,
    inputSchema: ZodRawShape,
    handler: (args: any, extra?: any) => Promise<unknown>,
  ) =>
    server.registerTool(name, { title: name, description, inputSchema }, async (args: any, extra: any) => {
      try {
        return asJson(await handler(args, extra));
      } catch (err) {
        return { ...asJson(errorMessage(err)), isError: true };
      }
    });

  const query = (params: Record<string, unknown>) => buildQueryString(params);

  const withDiscoveredProject = (args: any): any => {
    if (!projectId) return args;
    if (args && args.project_id !== undefined && args.project_id !== null && args.project_id !== '') {
      return args;
    }
    return { ...args, project_id: projectId };
  };

  const reportEvent = (type: string | ((args: any) => string), payloadFields: (args: any) => Record<string, unknown>) =>
    (args: any) => {
      const project_id = args.project_id ?? projectIdFromAgentId(args.agent_id);
      if (!project_id) {
        throw new Error(
          `Could not determine project_id from agent_id "${args.agent_id}" — pass project_id explicitly.`,
        );
      }
      const envelope: IngestEnvelopeInput = {
        event_id: args.idempotency_key,
        type: typeof type === 'function' ? type(args) : type,
        source: `agent:${args.agent_id}`,
        actor: args.agent_id,
        ...(args.task_id ? { task_id: args.task_id } : {}),
        payload: payloadFields(args),
      };
      return callCore(
        coreUrl,
        'POST',
        `/api/ingest/events${query({ project_id })}`,
        { events: [envelope] },
      );
    };

  // ---- Task CRUD -----------------------------------------------------------

  tool(
    'create_task',
    'Create a task in a project. Requires your agent_id (format <agent-string>_<project-id>), an objective-free title, and a fresh idempotency_key (reuse a key only to retry the identical call).',
    createTaskSchema.shape,
    (args) => {
      const resolved = withDiscoveredProject(args);
      if (!resolved.project_id) {
        throw new ValidationError(
          'project_id is required — pass it explicitly or initialize a project in this folder so it can be discovered.',
        );
      }
      return callCore(coreUrl, 'POST', '/api/tasks', { ...resolved, agentCall: true });
    },
  );

  tool(
    'get_task',
    'Fetch one task by id, including its current status and owner.',
    { task_id: z.string().min(1) },
    (args) => callCore(coreUrl, 'GET', `/api/tasks/${args.task_id}?agentCall=true`),
  );

  tool(
    'list_tasks',
    'List tasks in a project, optionally filtered by status and priority, with limit/offset paging (newest first).',
    listTasksQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/tasks${query({ ...withDiscoveredProject(args), agentCall: true })}`),
  );

  tool(
    'update_task',
    'Update the title, objective, priority or acceptance criteria of a task. Requires the current owner agent_id and an idempotency_key.',
    { task_id: z.string().min(1), ...updateTaskSchema.shape },
    (args) => callCore(coreUrl, 'PATCH', `/api/tasks/${args.task_id}`, { ...args, agentCall: true }),
  );

  // ---- Claims and transitions ----------------------------------------------

  tool(
    'claim_task',
    'Claim an open task (or recover an interrupted one, which reassigns ownership to you). When your client attaches a session id in the tool-call _meta, the claim also binds session to task for event correlation.',
    claimTaskSchema.shape,
    (args, extra) => {
      const sessionId = args.session_id ?? extractSessionId(extra?._meta);
      return callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/claim`, {
        ...args,
        ...(sessionId ? { session_id: sessionId } : {}),
        agentCall: true,
      });
    },
  );

  tool(
    'release_task',
    'Release a task you own, returning it to open.',
    releaseTaskSchema.shape,
    (args) => callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/release`, { ...args, agentCall: true }),
  );

  const transition =
    (target_status: string) =>
    (args: any) =>
      callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/transition`, {
        ...args,
        target_status,
        agentCall: true,
      });

  tool(
    'block_task',
    'Mark your in-progress task blocked. A reason is required.',
    blockTaskSchema.shape,
    transition('blocked'),
  );

  tool(
    'unblock_task',
    'Return your blocked task to open. A resolution_note describing how it was unblocked is required.',
    unblockTaskSchema.shape,
    transition('open'),
  );

  tool(
    'complete_task',
    'Mark your in-progress task completed (terminal).',
    completeTaskSchema.shape,
    transition('completed'),
  );

  tool(
    'cancel_task',
    'Cancel a task you own (terminal). A reason is required.',
    cancelTaskSchema.shape,
    transition('cancelled'),
  );

  tool(
    'mark_task_interrupted',
    'Mark your in-progress task interrupted because the attempt ended without completion. A reason is required; another agent can then recover it with claim_task.',
    interruptTaskSchema.shape,
    transition('interrupted'),
  );

  // ---- Continuity records --------------------------------------------------

  tool(
    'record_checkpoint',
    'Record a progress checkpoint on a task: what is done, findings, unresolved issues and next steps.',
    createCheckpointSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/checkpoints', { ...args, agentCall: true }),
  );

  tool(
    'record_decision',
    'Record a decision on a task, with rationale and rejected alternatives, so it survives the conversation.',
    createDecisionSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/decisions', { ...args, agentCall: true }),
  );

  tool(
    'supersede_decision',
    'Replace one of the task\'s decisions: the old record is kept and marked superseded, the replacement becomes active.',
    supersedeDecisionSchema.shape,
    (args) =>
      callCore(coreUrl, 'POST', `/api/decisions/${args.decision_id}/supersede`, { ...args, agentCall: true }),
  );

  // ---- Read-back for the next session -------------------------------------

  tool(
    'get_task_history',
    'Chronological, append-only event history for a task (creation, claims, transitions, checkpoints, decisions).',
    listEventsQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/events${query({ ...args, agentCall: true })}`),
  );

  tool(
    'get_resume_context',
    'Deterministic resume context for a task: identity, latest checkpoint, active decisions, progress, unresolved issues and recent events. Use this instead of assuming you remember the work.',
    { task_id: z.string().min(1) },
    (args) => callCore(coreUrl, 'GET', `/api/resume${query(args)}`),
  );

  tool(
    'export_handoff',
    'Export a task handoff as JSON or Markdown for another agent or a review.',
    { task_id: z.string().min(1), format: z.enum(['json', 'markdown']).default('json') },
    (args) =>
      callCore(coreUrl, 'GET', `/api/export/${args.format || 'json'}${query({ task_id: args.task_id })}`),
  );

  tool(
    'get_dashboard',
    'Dashboard overview: task stats, recent tasks and the project scope list. Pass project_id to scope to one project; omit it for all projects.',
    dashboardQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/dashboard${query({ ...args, agentCall: true })}`),
  );

  // ---- Agent reporting (ledger) -------------------------------------------

  tool(
    'start_agent_session',
    'Record the start of an agent session (ledger event, no task transition). Requires your agent_id and session_id plus a fresh idempotency_key.',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200),
    },
    reportEvent('agent_session_started', (a) => ({ agent_id: a.agent_id, session_id: a.session_id })),
  );

  tool(
    'end_agent_session',
    'Record the end of an agent session with a completion reason (ledger event, no task transition).',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200),
      reason: z.enum(['completed', 'interrupted', 'failed', 'timeout']),
      duration_ms: z.number().int().nonnegative().optional(),
      tool_call_count: z.number().int().nonnegative().optional(),
      failed_tool_call_count: z.number().int().nonnegative().optional(),
      files_touched: z.array(z.string().min(1).max(1024)).max(100).optional(),
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    },
    reportEvent('agent_session_ended', (a) => ({
      agent_id: a.agent_id,
      session_id: a.session_id,
      reason: a.reason,
      ...(a.duration_ms !== undefined ? { duration_ms: a.duration_ms } : {}),
      ...(a.tool_call_count !== undefined ? { tool_call_count: a.tool_call_count } : {}),
      ...(a.failed_tool_call_count !== undefined ? { failed_tool_call_count: a.failed_tool_call_count } : {}),
      ...(a.files_touched ? { files_touched: a.files_touched } : {}),
      ...(a.input_tokens !== undefined ? { input_tokens: a.input_tokens } : {}),
      ...(a.output_tokens !== undefined ? { output_tokens: a.output_tokens } : {}),
    })),
  );

  tool(
    'report_interruption',
    'Record that the agent session was interrupted (ledger event; task status is not changed).',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200),
      reason: z.string().min(1).max(2000).optional(),
    },
    reportEvent('agent_interrupted', (a) => ({
      agent_id: a.agent_id,
      session_id: a.session_id,
      ...(a.reason ? { reason: a.reason } : {}),
    })),
  );

  tool(
    'report_timeout',
    'Record that the agent session timed out (ledger event; task status is not changed).',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200),
      timeout_ms: z.number().int().nonnegative().optional(),
    },
    reportEvent('agent_timed_out', (a) => ({
      agent_id: a.agent_id,
      session_id: a.session_id,
      ...(a.timeout_ms !== undefined ? { timeout_ms: a.timeout_ms } : {}),
    })),
  );

  tool(
    'report_progress_milestone',
    'Record a progress milestone on a task or project (ledger event, no task transition).',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200).optional(),
      summary: z.string().min(1).max(2000),
    },
    reportEvent('progress_milestone', (a) => ({
      agent_id: a.agent_id,
      ...(a.session_id ? { session_id: a.session_id } : {}),
      summary: a.summary,
    })),
  );

  tool(
    'report_fulfilment',
    'Record fulfilment evidence (summary, findings, blockers, next steps, files changed). Ledger event; triggers checkpoint evaluation, never a task transition.',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200).optional(),
      summary: z.string().min(1).max(2000),
      findings: z.string().min(1).max(10000).optional(),
      blockers: z.string().min(1).max(5000).optional(),
      next_steps: z.string().min(1).max(5000).optional(),
      files_changed: z.array(z.string().min(1).max(1024)).max(100).optional(),
      duration_ms: z.number().int().nonnegative().optional(),
      tool_call_count: z.number().int().nonnegative().optional(),
      failed_tool_call_count: z.number().int().nonnegative().optional(),
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    },
    reportEvent('progress_fulfilment', (a) => ({
      agent_id: a.agent_id,
      ...(a.session_id ? { session_id: a.session_id } : {}),
      summary: a.summary,
      ...(a.findings ? { findings: a.findings } : {}),
      ...(a.blockers ? { blockers: a.blockers } : {}),
      ...(a.next_steps ? { next_steps: a.next_steps } : {}),
      ...(a.files_changed ? { files_changed: a.files_changed } : {}),
      ...(a.duration_ms !== undefined ? { duration_ms: a.duration_ms } : {}),
      ...(a.tool_call_count !== undefined ? { tool_call_count: a.tool_call_count } : {}),
      ...(a.failed_tool_call_count !== undefined ? { failed_tool_call_count: a.failed_tool_call_count } : {}),
      ...(a.input_tokens !== undefined ? { input_tokens: a.input_tokens } : {}),
      ...(a.output_tokens !== undefined ? { output_tokens: a.output_tokens } : {}),
    })),
  );

  tool(
    'report_verification',
    'Record a verification outcome: passed, failed or skipped, with check_type and detail (ledger event, no task transition).',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200).optional(),
      outcome: z.enum(['passed', 'failed', 'skipped']),
      check_type: z.string().min(1).max(200),
      detail: z.string().min(1).max(10000).optional(),
    },
    reportEvent(
      (a) => `verification_${a.outcome}`,
      (a) => ({
        agent_id: a.agent_id,
        ...(a.session_id ? { session_id: a.session_id } : {}),
        check_type: a.check_type,
        ...(a.detail ? { detail: a.detail } : {}),
      }),
    ),
  );

  tool(
    'report_tool_call',
    'Record a single tool call with target, duration, and outcome (ledger event; no task transition).',
    {
      agent_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200).optional(),
      task_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]{1,128}$/),
      session_id: z.string().min(1).max(200).optional(),
      tool: z.string().min(1).max(200),
      status: z.enum(['succeeded', 'failed']),
      duration_ms: z.number().int().nonnegative(),
      target: z.string().min(1).max(1024).optional(),
      tool_call_id: z.string().min(1).max(200).optional(),
    },
    reportEvent('agent_tool_call', (a) => ({
      agent_id: a.agent_id,
      ...(a.session_id ? { session_id: a.session_id } : {}),
      tool: a.tool,
      status: a.status,
      duration_ms: a.duration_ms,
      ...(a.target ? { target: a.target } : {}),
      ...(a.tool_call_id ? { tool_call_id: a.tool_call_id } : {}),
    })),
  );
}