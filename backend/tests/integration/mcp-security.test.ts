import { describe, it, expect } from 'vitest';
import { loadAdapterConfig } from '@workjournal/mcp-adapter/config';
import {
  checkRequest,
  isAllowedHost,
  isAllowedOrigin,
  isAuthorized,
} from '@workjournal/mcp-adapter/validate-headers';

/**
 * Unit tests for transport selection and DNS-rebinding / origin / token
 * validation (root AGENTS.md security: loopback binding, no auth by default,
 * but the HTTP MCP endpoint must reject browser-origin and rebound hosts).
 */
describe('MCP adapter config', () => {
  it('defaults to stdio transport against a loopback core service', () => {
    const config = loadAdapterConfig({} as NodeJS.ProcessEnv);
    expect(config.transport).toBe('stdio');
    expect(config.coreUrl).toBe('http://127.0.0.1:3737');
    expect(config.httpPort).toBe(3738);
    expect(config.authToken).toBeUndefined();
    expect(config.allowedHosts).toEqual(['127.0.0.1:3738', 'localhost:3738', '[::1]:3738']);
    expect(config.allowedOrigins).toContain('http://127.0.0.1:3738');
  });

  it('selects http transport and honors overrides', () => {
    const config = loadAdapterConfig({
      MCP_TRANSPORT: 'http',
      WORKJOURNAL_CORE_URL: 'http://core:3737',
      MCP_PORT: '8080',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'mcp:8080',
      MCP_ALLOWED_ORIGINS: 'http://localhost:5173',
      MCP_AUTH_TOKEN: 'secret',
    } as NodeJS.ProcessEnv);
    expect(config.transport).toBe('http');
    expect(config.coreUrl).toBe('http://core:3737');
    expect(config.httpPort).toBe(8080);
    expect(config.httpHost).toBe('0.0.0.0');
    expect(config.allowedHosts).toEqual(['mcp:8080']);
    expect(config.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(config.authToken).toBe('secret');
  });

  it('rejects an unknown transport name', () => {
    expect(() => loadAdapterConfig({ MCP_TRANSPORT: 'grpc' } as NodeJS.ProcessEnv)).toThrow(
      /MCP_TRANSPORT/,
    );
  });

  it('rejects an invalid port', () => {
    expect(() => loadAdapterConfig({ MCP_PORT: 'not-a-port' } as NodeJS.ProcessEnv)).toThrow(
      /MCP_PORT/,
    );
  });
});

describe('Host / Origin / token validation', () => {
  const hosts = ['127.0.0.1:3738', 'localhost:3738'];
  const origins = ['http://127.0.0.1:3738', 'http://localhost:3738'];

  it('accepts exact loopback host:port values, case-insensitively', () => {
    expect(isAllowedHost('127.0.0.1:3738', hosts)).toBe(true);
    expect(isAllowedHost('LocalHost:3738', hosts)).toBe(true);
  });

  it('rejects missing, rebound, or wrong-port hosts', () => {
    expect(isAllowedHost(undefined, hosts)).toBe(false);
    expect(isAllowedHost('', hosts)).toBe(false);
    expect(isAllowedHost('evil.example:3738', hosts)).toBe(false);
    expect(isAllowedHost('127.0.0.1:9999', hosts)).toBe(false);
  });

  it('allows absent Origin (CLI clients) but validates present origins', () => {
    expect(isAllowedOrigin(undefined, origins)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3738', origins)).toBe(true);
    expect(isAllowedOrigin('http://evil.example', origins)).toBe(false);
    expect(isAllowedOrigin('null', origins)).toBe(false);
  });

  it('enforces bearer token only when one is configured', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true);
    expect(isAuthorized('Bearer abc', undefined)).toBe(true);
    expect(isAuthorized('Bearer abc', 'abc')).toBe(true);
    expect(isAuthorized('Bearer wrong', 'abc')).toBe(false);
    expect(isAuthorized(undefined, 'abc')).toBe(false);
    expect(isAuthorized('Basic abc', 'abc')).toBe(false);
    expect(isAuthorized('Bearer', 'abc')).toBe(false);
  });

  it('checkRequest rejects host first, then origin, then auth', () => {
    const config = { allowedHosts: hosts, allowedOrigins: origins };

    const badHost = checkRequest(
      { host: 'evil.example:3738', origin: undefined, authorization: undefined },
      config,
    );
    expect(badHost).toMatchObject({ ok: false, status: 403, code: 'HOST_REJECTED' });

    const badOrigin = checkRequest(
      { host: '127.0.0.1:3738', origin: 'http://evil.example', authorization: undefined },
      config,
    );
    expect(badOrigin).toMatchObject({ ok: false, status: 403, code: 'ORIGIN_REJECTED' });

    const badAuth = checkRequest(
      { host: '127.0.0.1:3738', origin: undefined, authorization: 'Bearer nope' },
      { ...config, authToken: 'secret' },
    );
    expect(badAuth).toMatchObject({ ok: false, status: 401, code: 'UNAUTHORIZED' });

    const ok = checkRequest(
      { host: '127.0.0.1:3738', origin: undefined, authorization: 'Bearer secret' },
      { ...config, authToken: 'secret' },
    );
    expect(ok).toEqual({ ok: true });
  });
});
