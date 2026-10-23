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
  /**
   * Probe the core service and start it when it is unreachable (stdio only —
   * decision D-013). `MCP_AUTOSTART=0` (or `mcp --no-autostart`) restores the
   * previous fail-with-an-actionable-error behaviour.
   */
  autostart: boolean;
  /** Ask an autostarted core to serve the dashboard too (`mcp --with-ui`). */
  withUi: boolean;
  /** How long to wait for an autostarted core to answer /health. */
  autostartTimeoutMs: number;
  /**
   * How often the stdio adapter refreshes its client-heartbeat file
   * (`<home>/mcp-heartbeats/<pid>.json`) — the core's last-one-out
   * auto-stop watches these (decision D-013).
   */
  heartbeatSeconds: number;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Parse an on/off env flag (`1/true/yes/on` vs `0/false/no/off`). */
function parseFlag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean flag (1/0, true/false) — got "${raw}".`);
}

/** Parse a positive-integer env var, falling back to the default. */
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
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
    // D-013: stdio is self-starting by default; --no-autostart / MCP_AUTOSTART=0
    // opt out. Only meaningful for the stdio transport (HTTP is for Docker,
    // where the core is a separate container with its own healthcheck).
    autostart: parseFlag(env.MCP_AUTOSTART, true, 'MCP_AUTOSTART'),
    withUi: parseFlag(env.MCP_WITH_UI, false, 'MCP_WITH_UI'),
    autostartTimeoutMs: parsePositiveInt(
      env.MCP_AUTOSTART_TIMEOUT_MS,
      10_000,
      'MCP_AUTOSTART_TIMEOUT_MS',
    ),
    heartbeatSeconds: parsePositiveInt(env.MCP_HEARTBEAT_SECONDS, 30, 'MCP_HEARTBEAT_SECONDS'),
  };
}
