import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import {
  createTaskSchema,
  updateTaskSchema,
  claimTaskSchema,
  releaseTaskSchema,
  transitionTaskSchema,
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
} from '@workjournal/shared';
import { callCore } from '../client.js';
import { buildQueryString } from './query.js';

type Json = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const asJson = (result: unknown): Json => ({
  content: [
    { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
  ],
});

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Thin forwarding layer (root AGENTS.md): every input schema comes from
 * `@workjournal/shared`, so the tools cannot drift from the HTTP contract, and no
 * business logic lives here.
 */
export function registerTools(server: McpServer, coreUrl: string) {
  const tool = (
    name: string,
    description: string,
    inputSchema: ZodRawShape,
    handler: (args: any) => Promise<unknown>,
  ) =>
    server.registerTool(name, { title: name, description, inputSchema }, async (args: any) => {
      try {
        return asJson(await handler(args));
      } catch (err) {
        return { ...asJson(errorMessage(err)), isError: true };
      }
    });

  const query = (params: Record<string, unknown>) => buildQueryString(params);

  // ---- Task CRUD -----------------------------------------------------------

  tool(
    'create_task',
    'Create a task in a project. Requires your agent_id (format <agent-string>_<project-id>), an objective-free title, and a fresh idempotency_key (reuse a key only to retry the identical call).',
    createTaskSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/tasks', args),
  );

  tool(
    'get_task',
    'Fetch one task by id, including its current status, owner and version.',
    { task_id: z.string().min(1) },
    (args) => callCore(coreUrl, 'GET', `/api/tasks/${args.task_id}`),
  );

  tool(
    'list_tasks',
    'List tasks in a project, optionally filtered by status and priority, with limit/offset paging (newest first).',
    listTasksQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/tasks${query(args)}`),
  );

  tool(
    'update_task',
    'Update the title, objective, priority or acceptance criteria of a task. Requires the current owner agent_id, the expected_version from your last read, and an idempotency_key.',
    { task_id: z.string().min(1), ...updateTaskSchema.shape },
    (args) => callCore(coreUrl, 'PATCH', `/api/tasks/${args.task_id}`, args),
  );

  // ---- Claims and transitions --------------------------------------------

  tool(
    'claim_task',
    'Claim an open task (or recover an interrupted one, which reassigns ownership to you). Bumps the task version.',
    claimTaskSchema.shape,
    (args) => callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/claim`, args),
  );

  tool(
    'release_task',
    'Release a task you own, returning it to open.',
    releaseTaskSchema.shape,
    (args) => callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/release`, args),
  );

  const transition =
    (target_status: string) =>
    (args: any) =>
      callCore(coreUrl, 'POST', `/api/tasks/${args.task_id}/transition`, {
        ...args,
        target_status,
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
    'Record a progress checkpoint on a task: what is done, findings, unresolved issues and next steps. Include the task version you last read in expected_version.',
    createCheckpointSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/checkpoints', args),
  );

  tool(
    'record_decision',
    'Record a decision on a task, with rationale and rejected alternatives, so it survives the conversation.',
    createDecisionSchema.shape,
    (args) => callCore(coreUrl, 'POST', '/api/decisions', args),
  );

  tool(
    'supersede_decision',
    'Replace one of the task\'s decisions: the old record is kept and marked superseded, the replacement becomes active.',
    supersedeDecisionSchema.shape,
    (args) =>
      callCore(coreUrl, 'POST', `/api/decisions/${args.decision_id}/supersede`, args),
  );

  // ---- Read-back for the next session -------------------------------------

  tool(
    'get_task_history',
    'Chronological, append-only event history for a task (creation, claims, transitions, checkpoints, decisions).',
    listEventsQuerySchema.shape,
    (args) => callCore(coreUrl, 'GET', `/api/events${query(args)}`),
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
    (args) => callCore(coreUrl, 'GET', `/api/dashboard${query(args)}`),
  );
}
