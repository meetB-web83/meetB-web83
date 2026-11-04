import { createLogger } from '@workjournal/shared';

let _sessionLogger: ReturnType<typeof createLogger> | null = null;
const sessionLogger = new Proxy({} as ReturnType<typeof createLogger>, {
  get(_, prop: string) {
    if (!_sessionLogger) _sessionLogger = createLogger({ component: 'mcp-adapter', module: 'session-state' });
    return Reflect.get(_sessionLogger, prop);
  },
}) as ReturnType<typeof createLogger>;

export interface SessionState {
  currentTaskId?: string;
  currentTaskVersion?: number;
  agentId: string;
  projectId?: string;
}

/** Per-connection session state, keyed by McpServer instance. */
const sessionStateMap = new WeakMap<object, SessionState>();

/**
 * Get or create session state for an MCP server connection.
 * Derives agentId from clientInfo or WORKJOURNAL_AGENT_ID env.
 */
export function getSessionState(server: object, clientInfo?: { name?: string; version?: string }, envProjectId?: string): SessionState {
  let state = sessionStateMap.get(server);
  if (!state) {
    const agentString = clientInfo?.name || 'opencode';
    const projectId = envProjectId || process.env.WORKJOURNAL_PROJECT_ID;
    const agentId = projectId ? `${agentString}_${projectId}` : agentString;
    state = { agentId, projectId };
    sessionStateMap.set(server, state);
    sessionLogger.debug({ agentId, projectId: projectId ?? null }, 'session state initialized');
  }
  return state;
}

/** Update the session's current task and version after a successful write. */
export function setCurrentTask(server: object, taskId: string, version?: number): void {
  const state = sessionStateMap.get(server);
  if (state) {
    state.currentTaskId = taskId;
    if (version !== undefined) state.currentTaskVersion = version;
    sessionLogger.debug({ taskId, version }, 'session current task updated');
  }
}

/** Clear the session's current task (e.g., on terminal status). */
export function clearCurrentTask(server: object): void {
  const state = sessionStateMap.get(server);
  if (state) {
    state.currentTaskId = undefined;
    state.currentTaskVersion = undefined;
    sessionLogger.debug('session current task cleared');
  }
}

/** Get the current task id from session state, or undefined. */
export function getCurrentTaskId(server: object): string | undefined {
  return sessionStateMap.get(server)?.currentTaskId;
}

/** Get the current task version from session state, or undefined. */
export function getCurrentTaskVersion(server: object): number | undefined {
  return sessionStateMap.get(server)?.currentTaskVersion;
}

/** Get the agent id from session state. */
export function getAgentId(server: object): string {
  const state = sessionStateMap.get(server);
  if (!state) throw new Error('Session state not initialized');
  return state.agentId;
}

/** Get the project id from session state. */
export function getProjectId(server: object): string | undefined {
  return sessionStateMap.get(server)?.projectId;
}