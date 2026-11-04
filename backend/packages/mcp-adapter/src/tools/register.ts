import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolProfile } from '../config.js';
import { registerCoreTools } from './core-tools.js';
import { registerFullTools } from './full-tools.js';
import { registerLedgerTools } from './ledger-tools.js';
import { getSessionState } from './session-state.js';

/**
 * Register tools based on the selected profile.
 * - core: 6 agent-facing workflow tools
 * - full: 17 MVP spec tools + 9 ledger tools (26 total, backward compatible)
 * - core+ledger: 6 core + 9 ledger tools (15 total)
 */
export function registerTools(server: McpServer, coreUrl: string, projectId: string | undefined, toolProfile: ToolProfile) {
  // Initialize session state with projectId so tools can resolve project without explicit param
  getSessionState(server, { name: 'workjournal' }, projectId);
  
  switch (toolProfile) {
    case 'core':
      registerCoreTools(server, coreUrl, server);
      break;
    case 'full':
      // Full profile includes all 17 spec tools + 9 ledger tools (26 total)
      registerFullTools(server, coreUrl, projectId);
      break;
    case 'core+ledger':
      // Core profile (6 tools) + ledger tools (9 tools) = 15 tools
      registerCoreTools(server, coreUrl, server);
      registerLedgerTools(server, coreUrl);
      break;
  }
}