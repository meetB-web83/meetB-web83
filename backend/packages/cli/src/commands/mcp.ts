import { loadAdapterConfig } from '@workjournal/mcp-adapter/config';
import { runStdioAdapter } from '@workjournal/mcp-adapter/autostart';
import { startHttpServer } from '@workjournal/mcp-adapter/http-server';

export interface McpOptions {
  /** Run the Streamable HTTP transport instead of stdio. */
  http?: boolean;
  /** Autostart the core with the dashboard when it is down (stdio). */
  withUi?: boolean;
  /** Commander's `--no-autostart`: false only when the flag was passed. */
  autostart?: boolean;
}

/**
 * Run the MCP adapter from the same executable as the core service.
 *
 * Stdio (default): stdout carries ONLY the MCP JSON-RPC stream — every log
 * line goes to stderr. Before serving, the adapter ensures the core is up,
 * starting it detached when needed (decision D-013), and keeps a heartbeat
 * file so the auto-stopped core knows when the last client is gone. HTTP
 * (`--http`): Streamable HTTP on MCP_PORT (3738) — no autostart there (the
 * HTTP transport is the Docker/remote path, where the core is its own
 * container). The adapter is a thin forwarder and never opens SQLite
 * (backend AGENTS.md invariant #1) — all state lives in the core over
 * loopback HTTP.
 */
export async function mcpCommand(options: McpOptions = {}): Promise<void> {
  if (options.http && !process.env.MCP_TRANSPORT) process.env.MCP_TRANSPORT = 'http';
  if (options.withUi) process.env.MCP_WITH_UI = '1';
  if (options.autostart === false) process.env.MCP_AUTOSTART = '0';

  const config = loadAdapterConfig();
  if (config.transport === 'http') {
    await startHttpServer(config);
  } else {
    await runStdioAdapter(config);
  }
}
