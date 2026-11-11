import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callCore } from '../client.js';
import { buildQueryString } from './query.js';
import {
  getSessionState,
  getCurrentTaskId,
  getCurrentTaskVersion,
  getAgentId,
  getProjectId,
} from './session-state.js';
import { createLogger } from '@workjournal/shared';

let _resourcesLogger: ReturnType<typeof createLogger> | null = null;
const resourcesLogger = new Proxy({} as ReturnType<typeof createLogger>, {
  get(_, prop: string) {
    if (!_resourcesLogger) _resourcesLogger = createLogger({ component: 'mcp-adapter', module: 'resources' });
    return Reflect.get(_resourcesLogger, prop);
  },
}) as ReturnType<typeof createLogger>;

const RESOURCE_PREFIX = 'workjournal://';

/**
 * URI templates for the 6 essential MCP resources.
 * Each is a read-only view over data the agent already has access to via tools.
 * Resources are read-only and cache-friendly — MCP clients can cache them to
 * avoid repeated core service round-trips.
 */
export const RESOURCE_URIS = {
  sessionCurrent: `${RESOURCE_PREFIX}session/current`,
  tasksCurrent: `${RESOURCE_PREFIX}tasks/current`,
  resume: `${RESOURCE_PREFIX}resume/{task_id}`,
  tasksList: `${RESOURCE_PREFIX}tasks/list`,
  taskById: `${RESOURCE_PREFIX}tasks/{task_id}`,
  history: `${RESOURCE_PREFIX}history/{task_id}`,
} as const;

/**
 * Register all 6 MCP resources on the server.
 * Resources are read-only views; they never mutate state.
 * - session/current: pure session-state read (no core call)
 * - tasks/current: session state + one core GET
 * - resume/{task_id}: one core GET /api/resume
 * - tasks/list: one core GET /api/tasks (actionable filter)
 * - tasks/{task_id}: one core GET /api/tasks/:id
 * - history/{task_id}: one core GET /api/events?task_id=
 */
export function registerResources(server: McpServer, coreUrl: string, serverInstance: object) {
  // ── workjournal://session/current ────────────────────────────────────────
  server.registerResource(
    'session-current',
    RESOURCE_URIS.sessionCurrent,
    {
      description: 'Current session state: task id, version, agent id, project id. No core call — reads from adapter session memory.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const sessionState = getSessionState(serverInstance);
        const currentTaskId = getCurrentTaskId(serverInstance);
        const currentTaskVersion = getCurrentTaskVersion(serverInstance);
        const agentId = getAgentId(serverInstance);
        const projectId = getProjectId(serverInstance);

        return {
          contents: [
            {
              uri: RESOURCE_URIS.sessionCurrent,
              mimeType: 'application/json',
              text: JSON.stringify({
                currentTaskId,
                currentTaskVersion,
                agentId,
                projectId,
                hasCurrentTask: Boolean(currentTaskId),
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResource(RESOURCE_URIS.sessionCurrent, 'INTERNAL', String(err), 'Check adapter session state');
      }
    },
  );

  // ── workjournal://tasks/current ──────────────────────────────────────────
  server.registerResource(
    'tasks-current',
    RESOURCE_URIS.tasksCurrent,
    {
      description: 'Full details of the current task. Reads current task id from session state, then fetches from core.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const sessionState = getSessionState(serverInstance);
        const projectId = sessionState.projectId;
        if (!projectId) {
          return errorResource(RESOURCE_URIS.tasksCurrent, 'NO_PROJECT', 'No project found', 'Run workjournal init in your project root or set WORKJOURNAL_PROJECT_ID');
        }

        const taskId = getCurrentTaskId(serverInstance);
        if (!taskId) {
          return errorResource(RESOURCE_URIS.tasksCurrent, 'NO_CURRENT_TASK', 'No current task in session', 'Call start_session or create_task first');
        }

        const task = await callCore(coreUrl, 'GET', `/api/tasks/${taskId}${buildQueryString({ agentCall: true })}`);
        return {
          contents: [
            {
              uri: RESOURCE_URIS.tasksCurrent,
              mimeType: 'application/json',
              text: typeof task === 'string' ? task : JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('NO_TASK') || msg.includes('not found')) {
          return errorResource(RESOURCE_URIS.tasksCurrent, 'NO_TASK', msg, 'Check task id or project');
        }
        return errorResource(RESOURCE_URIS.tasksCurrent, 'INTERNAL', msg, 'Check core service is running');
      }
    },
  );

  // ── workjournal://resume/{task_id} ───────────────────────────────────────
  server.registerResource(
    'resume',
    RESOURCE_URIS.resume,
    {
      description: 'Deterministic resume context for a task: objective, status, latest checkpoint, active decisions, open issues, recent events.',
      mimeType: 'application/json',
    },
    async (_uri: URL, variables: any) => {
      try {
        const taskId = variables?.task_id;
        if (!taskId) {
          return errorResource(RESOURCE_URIS.resume, 'MISSING_TASK_ID', 'task_id parameter is required', 'Provide a task_id in the resource URI');
        }

        const context = await callCore(coreUrl, 'GET', `/api/resume${buildQueryString({ task_id: taskId })}`);
        return {
          contents: [
            {
              uri: RESOURCE_URIS.resume.replace('{task_id}', String(taskId)),
              mimeType: 'application/json',
              text: typeof context === 'string' ? context : JSON.stringify(context, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResource(RESOURCE_URIS.resume, 'INTERNAL', String(err), 'Check core service is running');
      }
    },
  );

  // ── workjournal://tasks/list ─────────────────────────────────────────────
  server.registerResource(
    'tasks-list',
    RESOURCE_URIS.tasksList,
    {
      description: 'Actionable task list + count summary (open, in_progress, interrupted) for the current project.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const sessionState = getSessionState(serverInstance);
        const projectId = sessionState.projectId;
        if (!projectId) {
          return errorResource(RESOURCE_URIS.tasksList, 'NO_PROJECT', 'No project found', 'Run workjournal init in your project root or set WORKJOURNAL_PROJECT_ID');
        }

        // Fetch counts + all actionable tasks in 2 parallel calls
        const [countsRes, tasksRes] = await Promise.all([
          callCore(coreUrl, 'GET', `/api/tasks/counts${buildQueryString({ project_id: projectId, agentCall: true })}`),
          callCore(coreUrl, 'GET', `/api/tasks${buildQueryString({ project_id: projectId, agentCall: true })}`),
        ]);

        const counts = countsRes as Record<string, number>;
        const allTasks = Array.isArray(tasksRes) ? tasksRes : (tasksRes as any).tasks || [];

        // Sort client-side: in_progress (owned by this agent first), then interrupted, then open by priority
        const agentId = getAgentId(serverInstance);
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const sorted = [...allTasks].sort((a, b) => {
          const aStatus = a.status;
          const bStatus = b.status;
          const statusRank = { in_progress: 0, interrupted: 1, open: 2 };
          const ar = statusRank[aStatus as keyof typeof statusRank] ?? 99;
          const br = statusRank[bStatus as keyof typeof statusRank] ?? 99;
          if (ar !== br) return ar - br;
          // Within in_progress: agent's own tasks first
          if (aStatus === 'in_progress' && bStatus === 'in_progress') {
            const aOwner = a.owner === agentId ? 0 : 1;
            const bOwner = b.owner === agentId ? 0 : 1;
            if (aOwner !== bOwner) return aOwner - bOwner;
          }
          // Within same status: priority high→low
          return (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 1) -
                 (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 1);
        });

        const byStatus = { in_progress: [] as any[], interrupted: [] as any[], open: [] as any[] };
        for (const t of sorted) {
          if (t.status === 'in_progress') byStatus.in_progress.push(t);
          else if (t.status === 'interrupted') byStatus.interrupted.push(t);
          else if (t.status === 'open') byStatus.open.push(t);
        }

        return {
          contents: [
            {
              uri: RESOURCE_URIS.tasksList,
              mimeType: 'application/json',
              text: JSON.stringify({
                projectId,
                counts,
                tasks: {
                  in_progress: byStatus.in_progress.map((t: any) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner })),
                  interrupted: byStatus.interrupted.map((t: any) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner })),
                  open: byStatus.open.map((t: any) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, owner: t.owner })),
                },
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResource(RESOURCE_URIS.tasksList, 'INTERNAL', String(err), 'Check core service is running');
      }
    },
  );

  // ── workjournal://tasks/{task_id} ────────────────────────────────────────
  server.registerResource(
    'task-by-id',
    RESOURCE_URIS.taskById,
    {
      description: 'Fetch a single task by its ID.',
      mimeType: 'application/json',
    },
    async (_uri: URL, variables: any) => {
      try {
        const taskId = variables?.task_id;
        if (!taskId) {
          return errorResource(RESOURCE_URIS.taskById, 'MISSING_TASK_ID', 'task_id parameter is required', 'Provide a task_id in the resource URI');
        }

        const sessionState = getSessionState(serverInstance);
        const projectId = sessionState.projectId;
        const queryParams = projectId ? { project_id: projectId, agentCall: true } : { agentCall: true };

        const task = await callCore(coreUrl, 'GET', `/api/tasks/${taskId}${buildQueryString(queryParams)}`);
        return {
          contents: [
            {
              uri: RESOURCE_URIS.taskById.replace('{task_id}', String(taskId)),
              mimeType: 'application/json',
              text: typeof task === 'string' ? task : JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('NO_TASK') || msg.includes('not found')) {
          return errorResource(RESOURCE_URIS.taskById, 'NO_TASK', msg, 'Check task id or project');
        }
        return errorResource(RESOURCE_URIS.taskById, 'INTERNAL', msg, 'Check core service is running');
      }
    },
  );

  // ── workjournal://history/{task_id} ──────────────────────────────────────
  server.registerResource(
    'task-history',
    RESOURCE_URIS.history,
    {
      description: 'Append-only event history for a task (creation, claims, transitions, checkpoints, decisions).',
      mimeType: 'application/json',
    },
    async (_uri: URL, variables: any) => {
      try {
        const taskId = variables?.task_id;
        if (!taskId) {
          return errorResource(RESOURCE_URIS.history, 'MISSING_TASK_ID', 'task_id parameter is required', 'Provide a task_id in the resource URI');
        }

        const events = await callCore(coreUrl, 'GET', `/api/events${buildQueryString({ task_id: taskId, limit: 100 })}`);
        return {
          contents: [
            {
              uri: RESOURCE_URIS.history.replace('{task_id}', String(taskId)),
              mimeType: 'application/json',
              text: typeof events === 'string' ? events : JSON.stringify(events, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResource(RESOURCE_URIS.history, 'INTERNAL', String(err), 'Check core service is running');
      }
    },
  );
}

function errorResource(uri: string, code: string, cause: string, recovery: string) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ error: { code, cause, recovery } }, null, 2),
      },
    ],
    isError: true,
  };
}
