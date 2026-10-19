import { loadAdapterConfig } from '@workjournal/mcp-adapter/config';
import { startStdioServer } from '@workjournal/mcp-adapter/stdio';
import { startHttpServer } from '@workjournal/mcp-adapter/http-server';

export interface McpOptions {
  /** Run the Streamable HTTP transport instead of stdio. */
  http?: boolean;
}

/**
 * Run the MCP adapter from the same executable as the core service.
 *
 * Stdio (default): stdout carries ONLY the MCP JSON-RPC stream — every log
 * line goes to stderr. HTTP (`--http`): Streamable HTTP on MCP_PORT (3738).
 * The adapter is a thin forwarder; it never opens SQLite (backend AGENTS.md
 * invariant #1) — all state lives in the core service over loopback HTTP.
 */
export async function mcpCommand(options: McpOptions = {}): Promise<void> {
  if (options.http && !process.env.MCP_TRANSPORT) process.env.MCP_TRANSPORT = 'http';
  const config = loadAdapterConfig();
  if (config.transport === 'http') {
    await startHttpServer(config);
  } else {
    await startStdioServer(config.coreUrl);
  }
}
