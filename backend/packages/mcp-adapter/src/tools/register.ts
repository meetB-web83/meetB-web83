import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCoreTools } from './core-tools.js';
import { getSessionState } from './session-state.js';

/**
 * Register all WorkJournal MCP tools. One canonical tool set — no profiles,
 * no env-based variation, no duplicated names or schemas.
 *
 * Tools: start_session, create_task, update_task, checkpoint, record_decision,
 *        get_resume_context, list_tasks
 *
 * Every tool shares the same session state (project id, agent id, current
 * task) so agents rarely need to pass project_id, agent_id, or task_id.
 */
export function registerTools(server: McpServer, coreUrl: string, projectId: string | undefined) {
  // Initialize session state with projectId so tools can resolve project without explicit param
  getSessionState(server, { name: 'workjournal' }, projectId);

  registerCoreTools(server, coreUrl, server);
}
