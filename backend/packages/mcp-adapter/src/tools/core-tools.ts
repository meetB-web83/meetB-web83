import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callCore } from '../client.js';
import { buildQueryString } from './query.js';
import { getSessionState, setCurrentTask, clearCurrentTask, getAgentId, getProjectId, getCurrentTaskId, getCurrentTaskVersion } from './session-state.js';
import { createHash } from 'node:crypto';

const CORE_TOOL_DESCRIPTIONS = {
  start_session: 'Call first when starting or resuming work. Returns your in_progress tasks, a resume brief for task_id, and the next step. With task_id and claim=true, claims ownership. Browse tasks with list_tasks.',
  create_task: 'Create a task for multi-step work. Becomes the current task.',
  update_task: 'Update the current task. status: in_progress=claim/resume, open=release/unblock (note=resolution), blocked|interrupted|cancelled need reason, completed=done. Other fields edit details.',
  checkpoint: 'Save progress so another agent can continue if this session ends. Call after each meaningful step and before stopping.',
  record_decision: 'Record a design choice others must follow. supersedes=<decision id> replaces an earlier one.',
  get_resume_context: 'Get what another agent needs to continue: objective, status, last checkpoint, active decisions, open issues. detail=brief|full.',
  list_tasks: 'See which tasks exist and which one to work on.',
} as const;

function deriveIdempotencyKey(tool: string, taskId: string, version: number, args: Record<string, unknown>, eventSequence?: number): string {
  const normalized: Record<string, unknown> = { tool, taskId, version, ...args };
  if (eventSequence !== undefined) normalized.eventSequence = eventSequence;
  const canonical = JSON.stringify(normalized, Object.keys(normalized).sort());
  return 'wj-' + createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function compactText(text: string, maxTokens = 150): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 20) + '... [truncated]';
}

function errorResponse(code: string, cause: string, recovery: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `[${code}] ${cause}. ${recovery}.` }],
  };
}

function successResponse(text: string, structured: Record<string, unknown>, nextActions: string[] = []) {
  return {
    content: [{ type: 'text' as const, text: compactText(text) }],
    structuredContent: structured,
    next_actions: nextActions.slice(0, 2).map(a => a.slice(0, 25)),
  };
}

export function registerCoreTools(server: McpServer, coreUrl: string, serverInstance: object) {
  // ---- start_session -------------------------------------------------------
  server.registerTool(
    'start_session',
    {
      title: 'Start Session',
      description: CORE_TOOL_DESCRIPTIONS.start_session,
      inputSchema: {
        task_id: z.string().optional().describe('Specific task to resume or claim'),
        claim: z.boolean().optional().default(false).describe('Claim this task (open/interrupted -> in_progress)'),
        project: z.string().optional().describe('Project override (normally inferred)'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const sessionState = getSessionState(serverInstance);
        const projectId = args.project ?? sessionState.projectId ?? process.env.WORKJOURNAL_PROJECT_ID;
        if (!projectId) {
          return errorResponse('NO_PROJECT', 'No project found', 'Run workjournal init in your project root or set WORKJOURNAL_PROJECT_ID');
        }

        // Get counts for summary
        const countsRes = await callCore(coreUrl, 'GET', `/api/tasks/counts${buildQueryString({ project_id: projectId, agentCall: true })}`);
        const counts = countsRes as Record<string, number>;

        const agentId = getAgentId(serverInstance);

        // Get only this agent's in_progress tasks for the response
        const listRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, status: 'in_progress', agentCall: true })}`);
        const myInProgress = Array.isArray(listRes) ? listRes.filter((t: any) => t.owner === agentId) : (listRes as any).tasks?.filter((t: any) => t.owner === agentId) || [];

        let currentTask = args.task_id;
        let claimed = false;

        if (args.task_id) {
          const taskRes = await callCore(coreUrl, 'GET', `/api/tasks/${args.task_id}${buildQueryString({ agentCall: true })}`);
          const task = taskRes as any;
          if (!task || !task.id) {
            return errorResponse('NO_TASK', `Task ${args.task_id} not found in project`, 'Check task id or project');
          }
          currentTask = args.task_id;
        } else if (args.claim) {
          // For claim without task_id, get open and interrupted tasks
          const openRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, status: 'open', agentCall: true })}`);
          const openTasks = Array.isArray(openRes) ? openRes : (openRes as any).tasks || [];
          const interruptedRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, status: 'interrupted', agentCall: true })}`);
          const interruptedTasks = Array.isArray(interruptedRes) ? interruptedRes : (interruptedRes as any).tasks || [];
          const candidates = [...openTasks, ...interruptedTasks];
          if (candidates.length === 1) {
            currentTask = candidates[0].id;
          } else if (candidates.length === 0) {
            return errorResponse('NO_TASK', 'No open or interrupted tasks to claim', 'Create a task first with create_task');
          } else {
            const list = candidates.map((t: any) => `${t.id}: ${t.title}`).join(', ');
            return errorResponse('AMBIGUOUS_TASK', `Multiple candidates: ${list}`, 'Provide task_id explicitly');
          }
        }

        if (currentTask && args.claim) {
          const idempotencyKey = deriveIdempotencyKey('start_session_claim', currentTask, 0, { task_id: currentTask });
          await callCore(coreUrl, 'POST', `/api/tasks/${currentTask}/claim`, {
            task_id: currentTask,
            agent_id: agentId,
            idempotency_key: idempotencyKey,
            agentCall: true,
            ...(extra?._meta?.sessionId ? { session_id: extra._meta.sessionId } : {}),
          });
          claimed = true;
        }

        let resumeBrief: any = null;
        let nextActions: string[] = [];

        if (currentTask) {
          setCurrentTask(serverInstance, currentTask);
          const resumeRes = await callCore(coreUrl, 'GET', `/api/resume${buildQueryString({ task_id: currentTask })}`);
          resumeBrief = {
            id: currentTask,
            ...resumeRes,
          };
          if (claimed) {
            nextActions.push('Task claimed. Call checkpoint to save progress.');
          } else {
            nextActions.push('Call checkpoint to save progress, or update_task to change status.');
          }
        } else {
          nextActions.push('Create a task with create_task, or provide task_id to resume. Browse tasks with list_tasks.');
        }

        const countParts: string[] = [];
        const statusOrder = ['open', 'in_progress', 'interrupted', 'blocked', 'completed', 'cancelled'];
        for (const status of statusOrder) {
          const c = counts[status] ?? 0;
          if (c > 0) countParts.push(`${c} ${status}`);
        }

        return successResponse(
          `Your tasks: ${myInProgress.length} in progress. Project: ${countParts.join(', ')}.${currentTask ? ` Current: ${currentTask}` : ''}`,
          { my_in_progress: myInProgress.map((t: any) => ({ id: t.id, title: t.title, status: t.status })), current_task: resumeBrief },
          nextActions
        );
      } catch (err) {
        return errorResponse('INTERNAL', String(err), 'Check core service is running and retry');
      }
    }
  );

  // ---- create_task ---------------------------------------------------------
  server.registerTool(
    'create_task',
    {
      title: 'Create Task',
      description: CORE_TOOL_DESCRIPTIONS.create_task,
      inputSchema: {
        title: z.string().min(1).max(500).describe('Task title'),
        objective: z.string().max(5000).optional().describe('Task objective'),
        acceptance: z.array(z.string().max(1000)).max(50).optional().describe('Acceptance criteria'),
        priority: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Priority level'),
        project: z.string().optional().describe('Project override'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const sessionState = getSessionState(serverInstance);
        const projectId = args.project ?? sessionState.projectId ?? process.env.WORKJOURNAL_PROJECT_ID;
        if (!projectId) {
          return errorResponse('NO_PROJECT', 'No project found', 'Run workjournal init in your project root or set WORKJOURNAL_PROJECT_ID');
        }

        const agentId = getAgentId(serverInstance);
        const idempotencyKey = deriveIdempotencyKey('create_task', '', 0, args);

        const created = await callCore(coreUrl, 'POST', '/api/tasks', {
          project_id: projectId,
          agent_id: agentId,
          title: args.title,
          objective: args.objective,
          acceptance_criteria: args.acceptance,
          priority: args.priority,
          idempotency_key: idempotencyKey,
          agentCall: true,
        });

        setCurrentTask(serverInstance, created.id, created.version);

        return successResponse(
          `Created task ${created.id}: ${created.title}`,
          { task: created },
          ['Call start_session with claim=true to begin work.']
        );
      } catch (err) {
        return errorResponse('INTERNAL', String(err), 'Check core service and retry');
      }
    }
  );

  // ---- update_task ---------------------------------------------------------
  server.registerTool(
    'update_task',
    {
      title: 'Update Task',
      description: CORE_TOOL_DESCRIPTIONS.update_task,
      inputSchema: {
        task_id: z.string().optional().describe('Task to update (defaults to current)'),
        status: z.enum(['in_progress', 'open', 'blocked', 'interrupted', 'completed', 'cancelled']).optional().describe('New status'),
        reason: z.string().max(2000).optional().describe('Required for blocked/interrupted/cancelled'),
        note: z.string().max(2000).optional().describe('Required when unblocking (resolution_note)'),
        title: z.string().max(500).optional().describe('New title'),
        objective: z.string().max(5000).optional().describe('New objective'),
        acceptance: z.array(z.string().max(1000)).max(50).optional().describe('New acceptance criteria'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('New priority'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    },
    async (args, extra) => {
      try {
        const taskId = args.task_id ?? getCurrentTaskId(serverInstance);
        if (!taskId) {
          return errorResponse('NO_TASK', 'No task specified and no current task in session', 'Provide task_id or call start_session first');
        }

        const sessionState = getSessionState(serverInstance);
        const agentId = getAgentId(serverInstance);
        const version = getCurrentTaskVersion(serverInstance) ?? 0;

        if (args.status) {
          if (['blocked', 'interrupted', 'cancelled'].includes(args.status) && !args.reason) {
            return errorResponse('MISSING_REASON', `status=${args.status} requires reason`, 'Provide reason parameter');
          }
        }

        const hasFieldEdits = args.title !== undefined || args.objective !== undefined || args.acceptance !== undefined || args.priority !== undefined;
        const hasStatusChange = args.status !== undefined;

        if (!hasFieldEdits && !hasStatusChange) {
          return errorResponse('INVALID_TRANSITION', 'No changes specified', 'Provide status or field edits');
        }

        let result: any;

        if (hasStatusChange) {
          const idempotencyKey = deriveIdempotencyKey('update_task_status', taskId, version, { status: args.status, reason: args.reason, note: args.note });

          switch (args.status) {
            case 'in_progress':
              result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/claim`, {
                task_id: taskId,
                agent_id: agentId,
                idempotency_key: idempotencyKey,
                agentCall: true,
                ...(extra?._meta?.sessionId ? { session_id: extra._meta.sessionId } : {}),
              });
              break;
            case 'open':
              try {
                result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/release`, {
                  task_id: taskId,
                  agent_id: agentId,
                  idempotency_key: idempotencyKey,
                  agentCall: true,
                });
              } catch (releaseErr) {
                if (!args.note) {
                  return errorResponse('MISSING_REASON', 'unblock requires note (resolution_note)', 'Provide note parameter');
                }
                result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/transition`, {
                  task_id: taskId,
                  agent_id: agentId,
                  target_status: 'open',
                  reason: args.note,
                  idempotency_key: idempotencyKey,
                  agentCall: true,
                });
              }
              break;
            case 'blocked':
              result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/transition`, {
                task_id: taskId,
                agent_id: agentId,
                target_status: 'blocked',
                reason: args.reason,
                idempotency_key: idempotencyKey,
                agentCall: true,
              });
              break;
            case 'interrupted':
              result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/transition`, {
                task_id: taskId,
                agent_id: agentId,
                target_status: 'interrupted',
                reason: args.reason,
                idempotency_key: idempotencyKey,
                agentCall: true,
              });
              break;
            case 'completed':
              result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/transition`, {
                task_id: taskId,
                agent_id: agentId,
                target_status: 'completed',
                idempotency_key: idempotencyKey,
                agentCall: true,
              });
              break;
            case 'cancelled':
              result = await callCore(coreUrl, 'POST', `/api/tasks/${taskId}/transition`, {
                task_id: taskId,
                agent_id: agentId,
                target_status: 'cancelled',
                reason: args.reason,
                idempotency_key: idempotencyKey,
                agentCall: true,
              });
              break;
          }
        }

        if (hasFieldEdits) {
          const idempotencyKey = deriveIdempotencyKey('update_task_fields', taskId, version, {
            title: args.title,
            objective: args.objective,
            acceptance_criteria: args.acceptance,
            priority: args.priority,
          });
          result = await callCore(coreUrl, 'PATCH', `/api/tasks/${taskId}`, {
            task_id: taskId,
            agent_id: agentId,
            title: args.title,
            objective: args.objective,
            acceptance_criteria: args.acceptance,
            priority: args.priority,
            idempotency_key: idempotencyKey,
            agentCall: true,
          });
        }

        if (result?.version !== undefined) {
          setCurrentTask(serverInstance, taskId, result.version);
        }

        if (args.status === 'completed' || args.status === 'cancelled') {
          clearCurrentTask(serverInstance);
        }

        const nextActions: string[] = [];
        if (args.status === 'completed') {
          nextActions.push('Task done. Call start_session for the next task.');
        } else if (args.status === 'cancelled') {
          nextActions.push('Task cancelled. Call start_session for the next task.');
        } else if (args.status === 'interrupted') {
          nextActions.push('Task interrupted. Another agent can recover with start_session(task_id, claim=true).');
        } else if (args.status === 'blocked') {
          nextActions.push('Task blocked. Resolve then update_task(status=open, note=...).');
        } else if (args.status === 'in_progress') {
          nextActions.push('Task claimed. Call checkpoint to save progress.');
        } else {
          nextActions.push('Task updated. Call checkpoint to save progress.');
        }

        return successResponse(
          `Task ${taskId} updated${args.status ? ` -> ${args.status}` : ''}`,
          { task: result },
          nextActions
        );
      } catch (err) {
        const msg = String(err);
        if (msg.includes('STALE_VERSION') || msg.includes('stale')) {
          return errorResponse('STALE_VERSION', 'Task was modified by another agent', 'Call get_resume_context, then retry');
        }
        if (msg.includes('NOT_OWNER') || msg.includes('owner')) {
          return errorResponse('NOT_OWNER', 'You do not own this task', 'Call start_session to see your tasks');
        }
        if (msg.includes('INVALID_TRANSITION') || msg.includes('invalid transition')) {
          return errorResponse('INVALID_TRANSITION', 'Status transition not allowed', 'Check current status and allowed transitions');
        }
        if (msg.includes('IDEMPOTENCY')) {
          return errorResponse('IDEMPOTENCY_CONFLICT', 'Duplicate request with different input', 'Use a new idempotency key or retry identical call');
        }
        return errorResponse('INTERNAL', msg, 'Check core service and retry');
      }
    }
  );

  // ---- checkpoint ----------------------------------------------------------
  server.registerTool(
    'checkpoint',
    {
      title: 'Checkpoint',
      description: CORE_TOOL_DESCRIPTIONS.checkpoint,
      inputSchema: {
        task_id: z.string().optional().describe('Task to checkpoint (defaults to current)'),
        summary: z.string().min(1).max(5000).describe('What was done (progress_summary)'),
        next_steps: z.array(z.string().max(5000)).max(50).min(1).describe('What to do next'),
        done: z.array(z.string().max(10000)).max(50).optional().describe('Completed work'),
        findings: z.array(z.string().max(10000)).max(50).optional().describe('Current findings'),
        issues: z.array(z.string().max(10000)).max(50).optional().describe('Unresolved issues'),
        files: z.array(z.string().max(1024)).max(50).optional().describe('File references'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const taskId = args.task_id ?? getCurrentTaskId(serverInstance);
        if (!taskId) {
          return errorResponse('NO_TASK', 'No task specified and no current task in session', 'Provide task_id or call start_session first');
        }

        const sessionState = getSessionState(serverInstance);
        const agentId = getAgentId(serverInstance);
        const version = getCurrentTaskVersion(serverInstance) ?? 0;

        let eventSequence = 0;
        try {
          const eventsRes = await callCore(coreUrl, 'GET', `/api/events${buildQueryString({ task_id: taskId, limit: 1 })}`);
          if (Array.isArray(eventsRes) && eventsRes.length > 0) {
            eventSequence = eventsRes[0].sequence;
          }
        } catch {
          // Ignore, use 0
        }

        const idempotencyKey = deriveIdempotencyKey('checkpoint', taskId, version, {
          summary: args.summary,
          next_steps: args.next_steps,
        }, eventSequence);

        const checkpoint = await callCore(coreUrl, 'POST', '/api/checkpoints', {
          task_id: taskId,
          agent_id: agentId,
          progress_summary: args.summary,
          completed_work: args.done?.join('\n'),
          current_findings: args.findings?.join('\n'),
          unresolved_issues: args.issues?.join('\n'),
          next_steps: args.next_steps.join('\n'),
          file_references: args.files,
          idempotency_key: idempotencyKey,
          agentCall: true,
        });

        let nextActions = ['Checkpoint saved.'];
        try {
          const eventsRes = await callCore(coreUrl, 'GET', `/api/events${buildQueryString({ task_id: taskId, limit: 50 })}`);
          const eventCount = Array.isArray(eventsRes) ? eventsRes.length : 0;
          if (eventCount > 10) {
            nextActions.push(`${eventCount} events since last checkpoint — consider another checkpoint.`);
          }
        } catch {
          // Ignore
        }

        return successResponse(
          `Checkpoint ${checkpoint.id} saved for task ${taskId}`,
          { checkpoint },
          nextActions
        );
      } catch (err) {
        return errorResponse('INTERNAL', String(err), 'Check core service and retry');
      }
    }
  );

  // ---- record_decision -----------------------------------------------------
  server.registerTool(
    'record_decision',
    {
      title: 'Record Decision',
      description: CORE_TOOL_DESCRIPTIONS.record_decision,
      inputSchema: {
        task_id: z.string().optional().describe('Task for decision (defaults to current)'),
        decision: z.string().min(1).max(2000).describe('Decision statement'),
        rationale: z.string().max(5000).optional().describe('Rationale'),
        supersedes: z.string().optional().describe('Decision id to replace'),
        alternatives: z.array(z.string().max(1000)).max(20).optional().describe('Rejected alternatives'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const taskId = args.task_id ?? getCurrentTaskId(serverInstance);
        if (!taskId) {
          return errorResponse('NO_TASK', 'No task specified and no current task in session', 'Provide task_id or call start_session first');
        }

        const sessionState = getSessionState(serverInstance);
        const agentId = getAgentId(serverInstance);
        const version = getCurrentTaskVersion(serverInstance) ?? 0;
        const idempotencyKey = deriveIdempotencyKey('record_decision', taskId, version, args);

        let result: any;

        if (args.supersedes) {
          result = await callCore(coreUrl, 'POST', `/api/decisions/${args.supersedes}/supersede`, {
            task_id: taskId,
            agent_id: agentId,
            decision_id: args.supersedes,
            replacement_statement: args.decision,
            replacement_rationale: args.rationale,
            idempotency_key: idempotencyKey,
            agentCall: true,
          });
        } else {
          result = await callCore(coreUrl, 'POST', '/api/decisions', {
            task_id: taskId,
            agent_id: agentId,
            statement: args.decision,
            rationale: args.rationale,
            alternatives: args.alternatives,
            idempotency_key: idempotencyKey,
            agentCall: true,
          });
        }

        return successResponse(
          `${args.supersedes ? 'Superseded' : 'Recorded'} decision ${result.id} for task ${taskId}`,
          { decision: result },
          ['Decision recorded. Call checkpoint to save progress.']
        );
      } catch (err) {
        return errorResponse('INTERNAL', String(err), 'Check core service and retry');
      }
    }
  );

  // ---- get_resume_context --------------------------------------------------
  server.registerTool(
    'get_resume_context',
    {
      title: 'Get Resume Context',
      description: CORE_TOOL_DESCRIPTIONS.get_resume_context,
      inputSchema: {
        task_id: z.string().optional().describe('Task to get context for (defaults to current)'),
        detail: z.enum(['brief', 'full']).optional().default('brief').describe('Detail level (brief ≤1500 tokens)'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const taskId = args.task_id ?? getCurrentTaskId(serverInstance);
        if (!taskId) {
          return errorResponse('NO_TASK', 'No task specified and no current task in session', 'Provide task_id or call start_session first');
        }

        const context = await callCore(coreUrl, 'GET', `/api/resume${buildQueryString({ task_id: taskId })}`);

        let truncated = false;
        if (args.detail === 'brief') {
          const text = JSON.stringify(context);
          if (text.length > 6000) {
            truncated = true;
          }
        }

        const text = args.detail === 'full'
          ? JSON.stringify(context, null, 2)
          : `${context.task?.title || 'Task'} (${context.task?.status || 'unknown'})\n${context.checkpoint?.progress_summary ? `Checkpoint: ${context.checkpoint.progress_summary.slice(0, 200)}` : 'No checkpoint'}\n${context.decisions?.length ? `Decisions: ${context.decisions.length} active` : 'No decisions'}\n${context.unresolved_issues ? `Issues: ${context.unresolved_issues.slice(0, 200)}` : 'No issues'}`;

        return successResponse(
          text + (truncated ? ' [truncated]' : ''),
          { ...context, truncated },
          ['Call update_task to change status, or checkpoint to save progress.']
        );
      } catch (err) {
        return errorResponse('INTERNAL', String(err), 'Check core service and retry');
      }
    }
  );

  // ---- list_tasks ------------------------------------------------------------
  server.registerTool(
    'list_tasks',
    {
      title: 'List Tasks',
      description: CORE_TOOL_DESCRIPTIONS.list_tasks,
      inputSchema: {
        status: z.string().optional().describe('Filter by status (single value or "all")'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('Filter by priority'),
        limit: z.number().int().min(1).max(25).optional().default(10).describe('Max tasks to return'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const sessionState = getSessionState(serverInstance);
        const projectId = sessionState.projectId ?? process.env.WORKJOURNAL_PROJECT_ID;
        if (!projectId) {
          return errorResponse('NO_PROJECT', 'No project found', 'Run workjournal init in your project root or set WORKJOURNAL_PROJECT_ID');
        }

        const agentId = getAgentId(serverInstance);

        // Get counts for summary
        const countsRes = await callCore(coreUrl, 'GET', `/api/tasks/counts${buildQueryString({ project_id: projectId, agentCall: true })}`);
        const counts = countsRes as Record<string, number>;

        // Build query for listing tasks
        const queryParams: Record<string, unknown> = { project_id: projectId, agentCall: true };
        if (args.status && args.status !== 'all') {
          queryParams.status = args.status;
        } else if (!args.status) {
          // Default: actionable tasks only (open, interrupted, in_progress)
          // We'll fetch all three and merge
        }
        if (args.priority) {
          queryParams.priority = args.priority;
        }
        const limit = args.limit ?? 10;

        let tasks: any[] = [];

        if (!args.status || args.status === 'all') {
          // Fetch actionable statuses separately and merge with ordering
          const inProgressRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, status: 'in_progress', agentCall: true })}`);
          const inProgressTasks = Array.isArray(inProgressRes) ? inProgressRes : (inProgressRes as any).tasks || [];
          const myInProgress = inProgressTasks.filter((t: any) => t.owner === agentId);

          const interruptedRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, status: 'interrupted', agentCall: true })}`);
          const interruptedTasks = Array.isArray(interruptedRes) ? interruptedRes : (interruptedRes as any).tasks || [];

          const openRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, status: 'open', agentCall: true })}`);
          const openTasks = Array.isArray(openRes) ? openRes : (openRes as any).tasks || [];

          // Order: my in_progress first, then interrupted, then open by priority (high > medium > low)
          const priorityOrder = { high: 0, medium: 1, low: 2 };
          const sortedOpen = [...openTasks].sort((a, b) => (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 1) - (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 1));

          tasks = [...myInProgress, ...interruptedTasks, ...sortedOpen];
        } else {
          // Specific status requested
          const listRes = await callCore(coreUrl, 'GET', `/api/tasks${buildQueryString(queryParams)}`);
          tasks = Array.isArray(listRes) ? listRes : (listRes as any).tasks || [];
        }

        // Apply limit
        const totalTasks = tasks.length;
        const displayedTasks = tasks.slice(0, limit);
        const truncated = totalTasks > limit;

        // Format task lines
        const taskLines = displayedTasks.map((t: any) => {
          const owner = t.owner ? ` @${t.owner}` : '';
          return `${t.id} ${t.title.slice(0, 60)} [${t.status}] [${t.priority}]${owner}`;
        });

        // Build count summary
        const countParts: string[] = [];
        const statusOrder = ['open', 'in_progress', 'interrupted', 'blocked', 'completed', 'cancelled'];
        for (const status of statusOrder) {
          const c = counts[status] ?? 0;
          if (c > 0) countParts.push(`${c} ${status}`);
        }

        let text = countParts.join(', ');
        if (taskLines.length > 0) {
          text += '\n' + taskLines.join('\n');
        }
        if (truncated) {
          text += `\n${totalTasks - limit} more`;
        }

        const nextActions = [
          'Call start_session(task_id, claim=true) to resume one.',
          'Call get_resume_context(task_id) for details.',
        ];

        return successResponse(
          text,
          { counts, tasks: displayedTasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner })) },
          nextActions
        );
      } catch (err) {
        return errorResponse('INTERNAL', String(err), 'Check core service and retry');
      }
    }
  );
}