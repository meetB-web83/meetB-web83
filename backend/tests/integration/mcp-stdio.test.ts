import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  buildServer,
  type Config,
} from '@workjournal/core';
import { createRegistryDb } from '../helpers/registry-factory.js';

/**
 * `workjournal mcp` (Phase 1 acceptance): the CLI subcommand runs the MCP
 * adapter over stdio — stdout must carry ONLY newline-delimited JSON-RPC
 * frames (any stray console.log would corrupt the protocol). Initialize,
 * tools/list and one forwarded tool call go through the real core service.
 *
 * The test spawns the BUILT CLI (`packages/cli/dist/index.js`), same as the
 * rest of the suite runs against built dist — run `pnpm build` first.
 */
const CLI_ENTRY = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  result?: { protocolVersion?: string; serverInfo?: { name?: string }; tools?: unknown[] };
  error?: { code: number; message: string };
}

describe('workjournal mcp over stdio', () => {
  let registry: ReturnType<typeof createRegistryDb>;
  let core: ReturnType<typeof buildServer>;
  let coreUrl: string;
  let child: ChildProcessWithoutNullStreams;
  /** Every non-empty line seen on stdout — asserted to be pure JSON-RPC. */
  let stdoutLines: string[] = [];
  const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
  let nextId = 1;

  const request = (method: string, params?: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(line);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for response to ${method}`));
      }, 10_000);
    });
  };

  const notify = (method: string): void => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  };

  beforeAll(async () => {
    // Real core service on a random loopback port (no DB mocks, real SQLite).
    registry = createRegistryDb();
    const config: Config = {
      workjournalHome: registry.dir,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      nodeEnv: 'test',
    };
    core = buildServer(registry.db, config);
    await core.listen({ host: '127.0.0.1', port: 0 });
    const address = core.server.address();
    if (address === null || typeof address === 'string') throw new Error('no core port');
    coreUrl = `http://127.0.0.1:${address.port}`;

    child = spawn(process.execPath, [CLI_ENTRY, 'mcp'], {
      env: { ...process.env, WORKJOURNAL_CORE_URL: coreUrl, MCP_TRANSPORT: 'stdio', LOG_LEVEL: 'silent' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      if (line.length === 0) return;
      stdoutLines.push(line);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return; // recorded; purity asserted in the final test
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    // Drain stderr so the child never blocks on a full pipe.
    createInterface({ input: child.stderr }).on('line', () => {});

    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'workjournal-tests', version: '0.0.0' },
    });
    expect(init.error).toBeUndefined();
    expect(init.result?.serverInfo).toBeDefined();
    notify('notifications/initialized');
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await core?.close();
    registry?.cleanup();
  });

  it('lists tools over stdio', async () => {
    const res = await request('tools/list');
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.result?.tools)).toBe(true);
    expect(res.result!.tools!.length).toBeGreaterThan(0);
  });

  it('forwards a tool call to the core service', async () => {
    const res = await request('tools/call', {
      name: 'get_dashboard',
      arguments: {},
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
  });

  it('writes ONLY JSON-RPC frames to stdout (protocol purity)', () => {
    expect(stdoutLines.length).toBeGreaterThan(0);
    for (const line of stdoutLines) {
      const parsed = JSON.parse(line) as JsonRpcMessage; // throws on non-JSON
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });
});

/**
 * `workjournal --version` / help must not crash and must exit 0 — cheap guard
 * that the CLI entry wires all subcommands (incl. mcp) without side effects.
 */
describe('workjournal CLI entry', () => {
  it('prints the version and exits 0', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [CLI_ENTRY, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', (d) => (buf += d));
      p.stderr.on('data', (d) => (buf += d));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}: ${buf}`))));
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 15_000);
});
