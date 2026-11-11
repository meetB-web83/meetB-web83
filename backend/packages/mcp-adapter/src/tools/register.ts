import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCoreTools } from './core-tools.js';
import { registerResources } from './resources.js';
import { getSessionState } from './session-state.js';

/**
 * Register all WorkJournal MCP tools and resources. One canonical tool set —
 * no profiles, no env-based variation, no duplicated names or schemas.
 *
 * Tools: start_session, create_task, update_task, checkpoint, record_decision,
 *        get_resume_context, list_tasks
 *
 * Resources (read-only, cache-friendly):
 *        workjournal://session/current, workjournal://tasks/current,
 *        workjournal://resume/{task_id}, workjournal://tasks/list,
 *        workjournal://tasks/{task_id}, workjournal://history/{task_id}
 *
 * Every tool shares the same session state (project id, agent id, current
 * task) so agents rarely need to pass project_id, agent_id, or task_id.
 */
export function registerTools(server: McpServer, coreUrl: string, projectId: string | undefined) {
  // Initialize session state with projectId so tools can resolve project without explicit param
  getSessionState(server, { name: 'workjournal' }, projectId);

  registerCoreTools(server, coreUrl, server);
  registerResources(server, coreUrl, server);
}
