import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Decision D-013 end-to-end, against the BUILT CLI (run `pnpm build` first,
 * same as mcp-stdio.test.ts): `workjournal mcp` brings a down core up by
 * itself, keeps it up while a client is connected, and lets it stop itself
 * once the last client is gone — plus the guard rails: `--no-autostart`,
 * source runs without an entry, and the rule that a manually started service
 * never auto-stops. Decision D-014: `mcp --with-ui` REPLACES an already
 * running core that lacks the dashboard — plus its guard rails (`--no-
 * autostart`, a core that already serves the UI, a core with no PID file,
 * which all fall back to attach-and-note).
 *
 * Windows note: child.kill() is an unconditional terminate, so the adapter's
 * SIGTERM cleanup does not run there — its heartbeat file goes stale and the
 * service releases it via the freshness window (AUTO_STOP_FRESH_SECONDS),
 * which is exactly the crash path the design must handle anyway.
 */

const CLI_ENTRY = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  result?: { protocolVersion?: string; serverInfo?: { name?: string }; tools?: unknown[] };
  error?: { code: number; message: string };
}

/** A loopback port that was free a moment ago (good enough for these tests). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close(() => reject(new Error('no address from ephemeral listen')));
        return;
      }
      const { port } = addr;
      server.close(() => resolvePort(port));
    });
  });
}

async function healthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when `GET /` serves the dashboard's HTML (same test the adapter uses). */
async function servesUi(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2_000) });
    return res.ok && (res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

/** Run the built CLI one-shot; resolves after exit (killed on timeout). */
function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeoutMs}ms: node index.js ${args.join(' ')}\n${out}\n${err}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

interface AdapterHandle {
  child: ChildProcess;
  stderrLines: string[];
  stdoutLines: string[];
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<JsonRpcMessage>;
  notify: (method: string) => void;
  /** Kill the adapter (hard, like a client crash) and wait for exit. */
  kill: () => Promise<void>;
}

function startAdapter(args: string[], env: Record<string, string>): AdapterHandle {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
  let nextId = 1;
  let exitInfo = '';

  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (line.length === 0) return;
    stdoutLines.push(line);
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // purity asserted by mcp-stdio.test.ts
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  createInterface({ input: child.stderr! }).on('line', (line) => stderrLines.push(line));

  child.on('exit', (code, signal) => {
    exitInfo = `adapter exited (code ${code ?? `signal ${signal}`})`;
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({ jsonrpc: '2.0', id, error: { code: -1, message: exitInfo } });
    }
  });

  const request = (method: string, params?: unknown, timeoutMs = 15_000): Promise<JsonRpcMessage> => {
    const id = nextId++;
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) {
          resolve({
            jsonrpc: '2.0',
            id,
            error: { code: -1, message: `timeout waiting for ${method}; ${exitInfo || stderrLines.slice(-5).join(' | ')}` },
          });
        }
      }, timeoutMs);
    });
  };

  return {
    child,
    stdoutLines,
    stderrLines,
    request,
    notify: (method: string) => {
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 5_000);
          child.once('exit', () => {
            clearTimeout(fallback);
            resolve();
          });
        });
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Core DOWN → adapter starts it, serves, heartbeats, auto-stops on exit
// ─────────────────────────────────────────────────────────────────────────────
describe('workjournal mcp autostart (real processes)', () => {
  let home: string;
  let base: string;
  let env: Record<string, string>;
  let adapter: AdapterHandle;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'wj-autostart-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = {
      WORKJOURNAL_CORE_URL: base,
      MCP_TRANSPORT: 'stdio',
      LOG_LEVEL: 'silent',
      WORKJOURNAL_HOME: home,
      HOST: '127.0.0.1',
      PORT: String(port),
      MCP_AUTOSTART_ENTRY: CLI_ENTRY,
      MCP_HEARTBEAT_SECONDS: '1',
      MCP_AUTOSTART_TIMEOUT_MS: '20000',
      // Short windows: fresh 2s + idle 3s + 1s poll ≈ 6s to auto-stop.
      AUTO_STOP_IDLE_SECONDS: '3',
      AUTO_STOP_POLL_SECONDS: '1',
      AUTO_STOP_FRESH_SECONDS: '2',
    };

    // The core is deliberately NOT running: port free, no PID file.
    expect(existsSync(join(home, 'service.pid'))).toBe(false);
    adapter = startAdapter(['mcp'], env);

    const init = await adapter.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'workjournal-autostart-tests', version: '0.0.0' },
      },
      30_000,
    );
    expect(init.error).toBeUndefined();
    expect(init.result?.serverInfo).toBeDefined();
    adapter.notify('notifications/initialized');

    const up = await waitFor(() => healthy(base), 20_000);
    expect(up, `autostarted core never became healthy; stderr:\n${adapter.stderrLines.join('\n')}`).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await adapter?.kill();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('detached-spawns the core with WORKJOURNAL_AUTOSTART=1 and a service log', () => {
    expect(existsSync(join(home, 'service.pid'))).toBe(true);
    expect(existsSync(join(home, 'service.log'))).toBe(true);
    expect(adapter.stderrLines.some((line) => /starting it/.test(line))).toBe(true);
    expect(
      adapter.stderrLines.some((line) => /WORKJOURNAL_AUTOSTART|pid \d+/i.test(line)),
    ).toBe(true);
  });

  it('forwards a tool call through the auto-started core', async () => {
    const res = await adapter.request('tools/call', { name: 'get_dashboard', arguments: {} });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
  });

  it('heartbeat keeps the service alive well past the idle window', async () => {
    // Idle window is 3s (fresh 2s on top if the heartbeat were dead) — a 7s
    // wait only passes when the adapter's heartbeat is actually refreshing.
    await sleep(7_000);
    expect(await healthy(base)).toBe(true);
    expect(existsSync(join(home, 'service.pid'))).toBe(true);
  }, 20_000);

  it('last one out: the service auto-stops after the client disconnects', async () => {
    await adapter.kill();
    const stopped = await waitFor(async () => !(await healthy(base)), 25_000, 300);
    expect(stopped, 'auto-started core did not stop within 25s of the last client dying').toBe(true);
    expect(existsSync(join(home, 'service.pid'))).toBe(false);
  }, 40_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Guard rails: --no-autostart, source run without an entry
// ─────────────────────────────────────────────────────────────────────────────
describe('autostart guard rails', () => {
  it('--no-autostart fails fast with the actionable error (old behaviour)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-noautostart-'));
    const port = await freePort();
    try {
      const result = await runCli(['mcp', '--no-autostart'], {
        WORKJOURNAL_CORE_URL: `http://127.0.0.1:${port}`,
        MCP_TRANSPORT: 'stdio',
        WORKJOURNAL_HOME: home,
      });
      expect(result.code).not.toBe(0);
      expect(result.err).toContain('workjournal start');
      expect(existsSync(join(home, 'service.pid'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('source run without MCP_AUTOSTART_ENTRY warns and fails actionably', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-noentry-'));
    const port = await freePort();
    try {
      const result = await runCli(['mcp'], {
        WORKJOURNAL_CORE_URL: `http://127.0.0.1:${port}`,
        MCP_TRANSPORT: 'stdio',
        WORKJOURNAL_HOME: home,
        MCP_AUTOSTART_ENTRY: '', // resolveSpawnTarget must come up empty
      });
      expect(result.code).not.toBe(0);
      expect(result.err).toContain('autostart is unavailable');
      expect(result.err).toContain('workjournal start');
      expect(existsSync(join(home, 'service.pid'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. UI conflict: core already up WITHOUT the dashboard + `mcp --with-ui`
//    (D-014): the adapter REPLACES it — plus the guard rails that all fall
//    back to attach-and-note instead of killing anything.
// ─────────────────────────────────────────────────────────────────────────────
describe('UI conflict override (core running, dashboard missing)', () => {
  /** Fresh env for one scenario: short auto-stop windows so the D-014
   *  replacement tears itself down last-one-out inside the test. */
  function scenarioEnv(home: string, port: number): Record<string, string> {
    return {
      WORKJOURNAL_HOME: home,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      WORKJOURNAL_CORE_URL: `http://127.0.0.1:${port}`,
      MCP_AUTOSTART_ENTRY: CLI_ENTRY,
      MCP_HEARTBEAT_SECONDS: '1',
      MCP_AUTOSTART_TIMEOUT_MS: '20000',
      AUTO_STOP_IDLE_SECONDS: '3',
      AUTO_STOP_POLL_SECONDS: '1',
      AUTO_STOP_FRESH_SECONDS: '2',
    };
  }

  /** Spawn a MANUAL core (no WORKJOURNAL_AUTOSTART — what `workjournal start` does). */
  function startManualCore(env: Record<string, string>, args: string[] = []): ChildProcess {
    return spawn(process.execPath, [CLI_ENTRY, 'start', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function readPid(home: string): string | null {
    try {
      return readFileSync(join(home, 'service.pid'), 'utf-8').trim();
    } catch {
      return null;
    }
  }

  const isAlive = (child: ChildProcess): boolean =>
    child.exitCode === null && child.signalCode === null;

  /** Kill a child and WAIT for its exit — Windows keeps a just-killed core's
   *  registry.db locked until the process is really gone (EBUSY on rmSync). */
  async function killAndWait(child: ChildProcess): Promise<void> {
    if (!isAlive(child)) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 5_000);
      child.once('exit', () => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }

  it('replaces the running UI-less core with one that serves the dashboard', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-override-'));
    const port = await freePort();
    const env = scenarioEnv(home, port);
    const base = env.WORKJOURNAL_CORE_URL;
    const service = startManualCore(env);
    let adapter: AdapterHandle | null = null;
    try {
      expect(await waitFor(() => healthy(base), 20_000), 'manual API-only core never came up').toBe(true);
      const oldPid = readPid(home);
      expect(oldPid, 'manual core did not write service.pid').not.toBeNull();
      expect(await servesUi(base), 'precondition: core serves no dashboard').toBe(false);

      adapter = startAdapter(['mcp', '--with-ui'], { ...env, MCP_TRANSPORT: 'stdio' });
      const init = await adapter.request(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'workjournal-override-tests', version: '0.0.0' },
        },
        30_000,
      );
      expect(init.error).toBeUndefined();
      adapter.notify('notifications/initialized');

      // The dashboard comes from the REPLACEMENT — the override ran.
      const replaced = await waitFor(() => servesUi(base), 30_000, 300);
      expect(replaced, `dashboard never appeared; stderr:\n${adapter.stderrLines.join('\n')}`).toBe(true);
      expect(
        adapter.stderrLines.some((line) => line.includes(`replacing it (pid ${oldPid})`)),
        `stderr was:\n${adapter.stderrLines.join('\n')}`,
      ).toBe(true);

      // The old process is really gone, and the PID file names the replacement.
      const died = await waitFor(async () => !isAlive(service), 15_000, 100);
      expect(died, 'old core was not stopped by the override').toBe(true);
      const newPid = readPid(home);
      expect(newPid, 'replacement never wrote service.pid').not.toBeNull();
      expect(newPid).not.toBe(oldPid);

      // MCP still serves through the replacement.
      const res = await adapter.request('tools/call', { name: 'get_dashboard', arguments: {} });
      expect(res.error).toBeUndefined();
      expect(res.result).toBeDefined();

      // The replacement was auto-spawned → last-one-out stops it when this
      // last client goes (the flag gate D-014 depends on).
      await adapter.kill();
      const stopped = await waitFor(async () => !(await healthy(base)), 25_000, 300);
      expect(stopped, 'replacement core did not auto-stop after its client left').toBe(true);
      expect(existsSync(join(home, 'service.pid'))).toBe(false);
    } finally {
      await adapter?.kill();
      await killAndWait(service);
      await runCli(['stop'], { ...env, LOG_LEVEL: 'silent' }).catch(() => undefined); // best-effort
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 90_000);

  it('--no-autostart opts out: attach + note, core untouched', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-override-noauto-'));
    const port = await freePort();
    const env = scenarioEnv(home, port);
    const base = env.WORKJOURNAL_CORE_URL;
    const service = startManualCore(env);
    let adapter: AdapterHandle | null = null;
    try {
      expect(await waitFor(() => healthy(base), 20_000)).toBe(true);
      const oldPid = readPid(home);

      adapter = startAdapter(['mcp', '--with-ui', '--no-autostart'], {
        ...env,
        MCP_TRANSPORT: 'stdio',
      });
      const init = await adapter.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'workjournal-override-tests', version: '0.0.0' },
      }, 30_000);
      expect(init.error).toBeUndefined();

      const noted = await waitFor(
        async () => adapter!.stderrLines.some((line) => line.includes('WITHOUT the dashboard')),
        10_000,
      );
      expect(noted, `stderr was:\n${adapter.stderrLines.join('\n')}`).toBe(true);
      // The attach itself is logged with the existing core's pid (D-015) …
      expect(
        adapter.stderrLines.some((line) =>
          line.includes(`connecting to existing core running at ${base} (pid: ${oldPid})`),
        ),
        `stderr was:\n${adapter.stderrLines.join('\n')}`,
      ).toBe(true);
      // No replacement, no spawn — the core is completely untouched.
      expect(adapter.stderrLines.some((line) => /replacing it|starting it/.test(line))).toBe(false);
      expect(readPid(home)).toBe(oldPid);
      expect(isAlive(service), 'core was killed despite --no-autostart').toBe(true);
      expect(await servesUi(base)).toBe(false);
    } finally {
      await adapter?.kill();
      await killAndWait(service);
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);

  it('attaches without a restart when the running core already serves the dashboard', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-override-hasui-'));
    const port = await freePort();
    const env = scenarioEnv(home, port);
    const base = env.WORKJOURNAL_CORE_URL;
    const service = startManualCore(env, ['--with-ui']);
    let adapter: AdapterHandle | null = null;
    try {
      expect(await waitFor(() => healthy(base), 20_000)).toBe(true);
      expect(await waitFor(() => servesUi(base), 10_000), 'core with --with-ui never served the UI').toBe(true);
      const oldPid = readPid(home);

      adapter = startAdapter(['mcp', '--with-ui'], { ...env, MCP_TRANSPORT: 'stdio' });
      const init = await adapter.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'workjournal-override-tests', version: '0.0.0' },
      }, 30_000);
      expect(init.error).toBeUndefined();

      // ensureCore has fully run by now: no replacement happened — but the
      // attach itself was logged with the existing core's pid (D-015).
      expect(
        adapter.stderrLines.some((line) =>
          line.includes(`connecting to existing core running at ${base} (pid: ${oldPid})`),
        ),
        `stderr was:\n${adapter.stderrLines.join('\n')}`,
      ).toBe(true);
      expect(adapter.stderrLines.some((line) => /replacing it|replacement core/.test(line))).toBe(false);
      expect(readPid(home)).toBe(oldPid);
      expect(isAlive(service), 'healthy UI-serving core was restarted for nothing').toBe(true);
      expect(await servesUi(base)).toBe(true);
    } finally {
      await adapter?.kill();
      await killAndWait(service);
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);

  it('attaches with a note when the running core has no PID file to identify it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-override-nopid-'));
    const port = await freePort();
    const env = scenarioEnv(home, port);
    const base = env.WORKJOURNAL_CORE_URL;
    const service = startManualCore(env);
    let adapter: AdapterHandle | null = null;
    try {
      expect(await waitFor(() => healthy(base), 20_000)).toBe(true);
      // Nothing to kill — e.g. a core outside this home (Docker/remote-ish).
      unlinkSync(join(home, 'service.pid'));

      adapter = startAdapter(['mcp', '--with-ui'], { ...env, MCP_TRANSPORT: 'stdio' });
      const init = await adapter.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'workjournal-override-tests', version: '0.0.0' },
      }, 30_000);
      expect(init.error).toBeUndefined();

      const noted = await waitFor(
        async () => adapter!.stderrLines.some((line) => line.includes('WITHOUT the dashboard')),
        10_000,
      );
      expect(noted, `stderr was:\n${adapter.stderrLines.join('\n')}`).toBe(true);
      expect(adapter.stderrLines.some((line) => line.includes('cannot identify'))).toBe(true);
      // No live PID behind the answer → the attach log says so (D-015).
      expect(
        adapter.stderrLines.some((line) =>
          line.includes(`connecting to existing core running at ${base} (pid: unknown)`),
        ),
        `stderr was:\n${adapter.stderrLines.join('\n')}`,
      ).toBe(true);
      expect(adapter.stderrLines.some((line) => line.includes('replacing it'))).toBe(false);
      expect(isAlive(service), 'core without a PID file was touched').toBe(true);
      expect(await servesUi(base)).toBe(false);
      expect(existsSync(join(home, 'service.pid'))).toBe(false);
    } finally {
      await adapter?.kill();
      await killAndWait(service);
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Manual start: the idle knobs are set, but the flag gate must hold
// ─────────────────────────────────────────────────────────────────────────────
describe('manual start never auto-stops', () => {
  it('survives well past the idle window without WORKJOURNAL_AUTOSTART', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-manual-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = {
      WORKJOURNAL_HOME: home,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      AUTO_STOP_IDLE_SECONDS: '3',
      AUTO_STOP_POLL_SECONDS: '1',
      AUTO_STOP_FRESH_SECONDS: '2',
      // Deliberately NO WORKJOURNAL_AUTOSTART — user ran `start` by hand.
    };

    const service = spawn(process.execPath, [CLI_ENTRY, 'start'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      expect(await waitFor(() => healthy(base), 20_000)).toBe(true);
      await sleep(6_000); // 2× the idle window with zero heartbeats present
      expect(await healthy(base), 'manual service was auto-stopped — flag gate broken').toBe(true);

      const stop = await runCli(['stop'], { ...env, LOG_LEVEL: 'silent' });
      expect(stop.code).toBe(0);
      expect(await waitFor(async () => !(await healthy(base)), 15_000)).toBe(true);
      expect(existsSync(join(home, 'service.pid'))).toBe(false);
    } finally {
      if (service.exitCode === null) service.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
