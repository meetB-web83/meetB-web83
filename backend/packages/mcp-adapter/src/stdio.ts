import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory.js';
import { createLogger } from '@workjournal/shared';

let _stdioLogger: ReturnType<typeof createLogger> | null = null;
const stdioLogger = new Proxy({} as ReturnType<typeof createLogger>, {
  get(_, prop: string) {
    if (!_stdioLogger) _stdioLogger = createLogger({ component: 'mcp-adapter', module: 'stdio' });
    return Reflect.get(_stdioLogger, prop);
  },
}) as ReturnType<typeof createLogger>;

/**
 * Native local-development transport. Nothing may be written to stdout here —
 * stdout carries the MCP JSON-RPC stream.
 */
export async function startStdioServer(
  coreUrl: string,
  projectId?: string,
): Promise<void> {
  stdioLogger.info({ coreUrl, projectId: projectId ?? null }, 'connecting MCP server to stdio transport');
  const server = await createMcpServer(coreUrl, projectId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stdioLogger.info({ coreUrl }, 'MCP server connected to stdio transport');
}
