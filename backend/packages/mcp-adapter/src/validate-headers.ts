import { timingSafeEqual } from 'node:crypto';

export interface RequestCheckInput {
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
}

export type CheckResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: string; message: string };

/**
 * Host header must exactly match one of the configured `host:port` values.
 * A missing or unexpected Host means the request was addressed to us by
 * something other than a local MCP client (e.g. DNS rebinding), so it is
 * rejected with 403. (MCP Streamable HTTP spec: servers MUST validate the
 * Host header to prevent DNS-rebinding attacks.)
 */
export function isAllowedHost(
  host: string | undefined,
  allowedHosts: string[],
): boolean {
  if (!host) return false;
  return allowedHosts.includes(host.toLowerCase());
}

/**
 * Browser clients send an Origin header; CLI MCP clients do not. A present
 * Origin must be on the allowlist — this blocks browser pages (and DNS-rebound
 * attacker domains) from invoking tools. Absent Origin is allowed because
 * non-browser MCP clients never send one and Host validation still applies.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin.toLowerCase());
}

/** Constant-time bearer-token comparison; always true when no token is configured. */
export function isAuthorized(
  authorization: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true;
  if (!authorization) return false;
  const [scheme, token] = authorization.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Full per-request security check for the /mcp endpoint. */
export function checkRequest(
  input: RequestCheckInput,
  config: { allowedHosts: string[]; allowedOrigins: string[]; authToken?: string },
): CheckResult {
  if (!isAllowedHost(input.host, config.allowedHosts)) {
    return {
      ok: false,
      status: 403,
      code: 'HOST_REJECTED',
      message: `Host header "${input.host ?? ''}" is not allowed for the WorkJournal MCP endpoint.`,
    };
  }
  if (!isAllowedOrigin(input.origin, config.allowedOrigins)) {
    return {
      ok: false,
      status: 403,
      code: 'ORIGIN_REJECTED',
      message: `Origin "${input.origin ?? ''}" is not allowed for the WorkJournal MCP endpoint.`,
    };
  }
  if (!isAuthorized(input.authorization, config.authToken)) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'A valid Bearer token is required for the WorkJournal MCP endpoint.',
    };
  }
  return { ok: true };
}
