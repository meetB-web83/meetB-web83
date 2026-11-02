import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@workjournal/shared';

/** Walk up from `startDir` looking for `.workjournal/project.json` (like Git
 *  finds `.git`). Returns the marker contents and path, or null. Path-spelling
 *  safe: no string matching against host/container/WSL paths. */
let _configLogger: ReturnType<typeof createLogger> | null = null;
const configLogger = new Proxy({} as ReturnType<typeof createLogger>, {
  get(_, prop: string) {
    if (!_configLogger) _configLogger = createLogger({ component: 'mcp-adapter', module: 'config' });
    return Reflect.get(_configLogger, prop);
  },
}) as ReturnType<typeof createLogger>;

export function discoverProjectIdFromCwd(startDir: string = process.cwd()):
  | { projectId: string; markerPath: string }
  | null {
  let dir = resolve(startDir);
  configLogger.info({ startDir, resolvedDir: dir }, 'discoverProjectIdFromCwd: starting directory walk');
  let steps = 0;
  while (true) {
    steps++;
    const marker = resolve(dir, '.workjournal', 'project.json');
    configLogger.debug({ dir, marker, step: steps }, 'discoverProjectIdFromCwd: checking directory for marker');
    if (existsSync(marker)) {
      configLogger.info({ dir, marker, step: steps }, 'discoverProjectIdFromCwd: marker file found');
      try {
        const parsed = JSON.parse(readFileSync(marker, 'utf-8')) as {
          projectId?: string;
        };
        if (parsed.projectId) {
          configLogger.info(
            { dir, marker, step: steps, projectId: parsed.projectId },
            'discoverProjectIdFromCwd: project id identified from marker',
          );
          return { projectId: parsed.projectId, markerPath: marker };
        }
        configLogger.warn({ dir, marker, step: steps }, 'discoverProjectIdFromCwd: marker found but no project id — continuing upward');
      } catch {
        configLogger.warn({ dir, marker, step: steps }, 'discoverProjectIdFromCwd: marker unreadable — continuing upward');
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) {
      configLogger.info({ startDir, steps, reachedRoot: true }, 'discoverProjectIdFromCwd: reached filesystem root — no project id found');
      return null;
    }
    dir = parent;
  }
}

export interface AdapterConfig {
  /** Which transport to run: 'stdio' (default, native dev) or 'http' (Docker / remote clients). */
  transport: 'stdio' | 'http';
  /** Project id discovered from a `.workjournal/project.json` marker walked up
   *  from cwd (undefined when no marker is found). */
  projectId?: string;
  /** Absolute path to the marker file that supplied `projectId`, if any. */
  markerPath?: string;
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

  // Project id: explicit env wins; otherwise walk up from cwd for the marker.
  const envProjectId = env.WORKJOURNAL_PROJECT_ID || undefined;
  const discovered = envProjectId
    ? undefined
    : discoverProjectIdFromCwd();

  configLogger.info(
    {
      envProjectId: envProjectId ?? null,
      discoveredProjectId: discovered?.projectId ?? null,
      markerPath: discovered?.markerPath ?? null,
      source: envProjectId ? 'env' : discovered ? 'marker' : 'none',
    },
    'loadAdapterConfig: project id resolution',
  );

  return {
    transport: rawTransport,
    coreUrl: env.WORKJOURNAL_CORE_URL || 'http://127.0.0.1:3737',
    ...(envProjectId ? { projectId: envProjectId } : {}),
    ...(discovered ? { projectId: discovered.projectId, markerPath: discovered.markerPath } : {}),
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
