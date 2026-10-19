export interface AdapterConfig {
  /** Which transport to run: 'stdio' (default, native dev) or 'http' (Docker / remote clients). */
  transport: 'stdio' | 'http';
  /** Core service base URL. In Docker this is the Compose service name, e.g. http://core:3737. */
  coreUrl: string;
  /** Bind address for the HTTP transport (loopback by default). */
  httpHost: string;
  /** Port for the HTTP transport. */
  httpPort: number;
  /** Exact `host:port` values allowed in the Host header (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Exact origins allowed in the Origin header; absent Origin is always allowed (non-browser clients). */
  allowedOrigins: string[];
  /** Optional bearer token required on /mcp when set (write-protection for HTTP mode). */
  authToken: string | undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Adapter configuration from environment variables. Defaults keep the historical
 * local-dev behaviour (stdio transport against a loopback core service).
 */
export function loadAdapterConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const rawTransport = (env.MCP_TRANSPORT || 'stdio').toLowerCase();
  if (rawTransport !== 'stdio' && rawTransport !== 'http') {
    throw new Error(
      `MCP_TRANSPORT must be "stdio" or "http" (got "${env.MCP_TRANSPORT}").`,
    );
  }

  const httpPort = parseInt(env.MCP_PORT || '3738', 10);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`MCP_PORT must be a valid TCP port (got "${env.MCP_PORT}").`);
  }

  const httpHost = env.MCP_HTTP_HOST || '127.0.0.1';

  return {
    transport: rawTransport,
    coreUrl: env.WORKJOURNAL_CORE_URL || 'http://127.0.0.1:3737',
    httpHost,
    httpPort,
    allowedHosts: splitList(env.MCP_ALLOWED_HOSTS) ?? [
      `127.0.0.1:${httpPort}`,
      `localhost:${httpPort}`,
      `[::1]:${httpPort}`,
    ],
    allowedOrigins: splitList(env.MCP_ALLOWED_ORIGINS) ?? [
      `http://127.0.0.1:${httpPort}`,
      `http://localhost:${httpPort}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ],
    authToken: env.MCP_AUTH_TOKEN || undefined,
  };
}
