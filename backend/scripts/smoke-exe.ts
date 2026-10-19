/**
 * Smoke test for `dist-bin/workjournal(.exe)` — Phase 2 acceptance. Run as
 * `pnpm smoke:exe` from `backend/` after `pnpm build:exe`.
 *
 * Verifies the single-file executable end to end, no Node install needed:
 *   1. `--version` exits 0 and prints a semver;
 *   2. `start --with-ui` on a random loopback port with a TEMPORARY
 *      WORKJOURNAL_HOME serves, on the SAME port (same origin):
 *        - GET /        → the SPA (HTML),
 *        - GET /health  → {"status":"ok"},
 *        - GET /api/projects → a JSON array;
 *      this also proves the embedded migrations (registry DB created from the
 *      embedded arrays) and the embedded dashboard assets both work;
 *   3. `mcp` over stdio: initialize + tools/list handshake, and stdout carries
 *      ONLY JSON-RPC frames (protocol purity);
 *   4. `stop` terminates the service, removes the PID file and frees the port.
 *
 * Modeled on tests/integration/ui-serving.test.ts and mcp-stdio.test.ts, but
 * standalone: it exercises the built BINARY, so it must not depend on the
 * workspace's node_modules at run time. `--open` is deliberately untested —
 * the smoke run must never pop a browser. Exits non-zero on the first failure
 * with the captured service log for diagnosis.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // backend/scripts/
const backendRoot = resolve(here, '..');
const exeName = process.platform === 'win32' ? 'workjournal.exe' : 'workjournal';
const exePath = join(backendRoot, 'dist-bin', exeName);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ok(message: string): void {
  process.stdout.write(`  ✓ ${message}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface RunResult {
  code: number | null;
  out: string;
}

/** Run the executable one-shot (no long-lived process), capturing all output. */
function runExe(args: string[], env: Record<string, string>, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exePath, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeoutMs}ms: workjournal ${args.join(' ')}\n${out}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

/** A loopback port that was free a moment ago (good enough for a smoke test). */
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

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  result?: { protocolVersion?: string; serverInfo?: { name?: string }; tools?: unknown[] };
  error?: { code: number; message: string };
}

async function main(): Promise<void> {
  if (!existsSync(exePath)) {
    throw new Error(`Executable not found: ${exePath}\nBuild it first: pnpm build:exe`);
  }

  const home = mkdtempSync(join(tmpdir(), 'workjournal-smoke-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let service: ChildProcess | null = null;
  let serviceLog = '';
  let mcp: ChildProcess | null = null;

  const serviceEnv = {
    WORKJOURNAL_HOME: home,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'silent',
  };

  try {
    // ── 1. --version ──
    process.stdout.write('== step 1: --version\n');
    const version = await runExe(['--version'], serviceEnv);
    assert(version.code === 0, `expected exit 0, got ${version.code}: ${version.out}`);
    assert(/^\d+\.\d+\.\d+/.test(version.out.trim()), `not a semver: ${version.out}`);
    ok(`prints ${version.out.trim()} and exits 0`);

    // ── 2. start --with-ui: UI + API on one port ──
    process.stdout.write('== step 2: start --with-ui (same-origin UI + API)\n');
    service = spawn(exePath, ['start', '--with-ui'], {
      env: { ...process.env, ...serviceEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout?.on('data', (d: Buffer) => (serviceLog += d.toString()));
    service.stderr?.on('data', (d: Buffer) => (serviceLog += d.toString()));
    service.on('error', (err) => (serviceLog += `spawn error: ${String(err)}`));

    const deadline = Date.now() + 30_000;
    let healthy = false;
    let lastErr = '';
    while (!healthy && Date.now() < deadline) {
      if (service.exitCode !== null || service.signalCode !== null) {
        throw new Error(
          `service exited early (code ${service.exitCode ?? `signal ${service.signalCode}`}):\n` +
            serviceLog,
        );
      }
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) healthy = true;
        else lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = String(err);
      }
      if (!healthy) await sleep(250);
    }
    assert(healthy, `service never answered /health within 30s (${lastErr}):\n${serviceLog}`);
    ok(`service healthy on ${baseUrl}`);

    const index = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) });
    const indexHtml = await index.text();
    assert(index.status === 200, `GET / → ${index.status}`);
    assert(
      (index.headers.get('content-type') ?? '').includes('text/html'),
      `GET / content-type is ${index.headers.get('content-type')}`,
    );
    assert(/<div/i.test(indexHtml), 'GET / does not look like the SPA (no <div found)');
    ok('GET / serves the embedded dashboard (HTML)');

    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const healthBody = await health.json();
    assert(health.status === 200, `GET /health → ${health.status}`);
    assert(
      JSON.stringify(healthBody) === JSON.stringify({ status: 'ok' }),
      `GET /health body: ${JSON.stringify(healthBody)}`,
    );
    ok('GET /health returns {"status":"ok"}');

    const projects = await fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(5000) });
    const projectsBody: unknown = await projects.json();
    assert(projects.status === 200, `GET /api/projects → ${projects.status}`);
    assert(Array.isArray(projectsBody), `GET /api/projects is not an array: ${JSON.stringify(projectsBody)}`);
    ok('GET /api/projects returns a JSON array (embedded registry migrations ran)');

    // ── 3. mcp over stdio: handshake + protocol purity ──
    process.stdout.write('== step 3: mcp stdio handshake\n');
    mcp = spawn(exePath, ['mcp'], {
      env: {
        ...process.env,
        WORKJOURNAL_CORE_URL: baseUrl,
        MCP_TRANSPORT: 'stdio',
        LOG_LEVEL: 'silent',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcp.on('error', (err) => process.stderr.write(`mcp spawn error: ${String(err)}\n`));

    const stdoutLines: string[] = [];
    const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
    let nextId = 1;
    createInterface({ input: mcp.stdout! }).on('line', (line) => {
      if (line.length === 0) return;
      stdoutLines.push(line);
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return; // purity asserted below
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    // Drain stderr so the child never blocks on a full pipe.
    createInterface({ input: mcp.stderr! }).on('line', () => {});

    const request = (method: string, params?: unknown): Promise<JsonRpcMessage> => {
      const id = nextId++;
      mcp!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((res, rej) => {
        pending.set(id, res);
        setTimeout(() => {
          if (pending.delete(id)) rej(new Error(`timeout waiting for ${method}`));
        }, 10_000);
      });
    };

    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'workjournal-smoke', version: '0.0.0' },
    });
    assert(!init.error, `initialize error: ${JSON.stringify(init.error)}`);
    assert(init.result?.serverInfo, 'initialize returned no serverInfo');
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    ok('initialize handshake OK');

    const tools = await request('tools/list');
    assert(!tools.error, `tools/list error: ${JSON.stringify(tools.error)}`);
    assert(
      Array.isArray(tools.result?.tools) && tools.result!.tools!.length > 0,
      'tools/list returned no tools',
    );
    ok(`tools/list returns ${tools.result!.tools!.length} tools`);

    for (const line of stdoutLines) {
      const parsed = JSON.parse(line) as JsonRpcMessage; // throws → caught by main
      assert(parsed.jsonrpc === '2.0', `non-JSON-RPC line on stdout: ${line}`);
    }
    ok(`stdout carried only JSON-RPC frames (${stdoutLines.length} lines)`);

    mcp.stdin!.end();
    mcp.kill();
    await new Promise<void>((res) => {
      if (mcp!.exitCode !== null || mcp!.signalCode !== null) return res();
      const fallback = setTimeout(res, 5_000);
      mcp!.once('exit', () => {
        clearTimeout(fallback);
        res();
      });
    });
    mcp = null;

    // ── 4. stop ──
    process.stdout.write('== step 4: stop\n');
    const stopped = await runExe(['stop'], serviceEnv);
    assert(stopped.code === 0, `stop exited ${stopped.code}: ${stopped.out}`);
    assert(/Stopped WorkJournal service/.test(stopped.out), `unexpected stop output: ${stopped.out}`);
    assert(!existsSync(join(home, 'service.pid')), 'service.pid still present after stop');
    ok('stop reports success and removes service.pid');

    const exitDeadline = Date.now() + 15_000;
    while (service.exitCode === null && service.signalCode === null && Date.now() < exitDeadline) {
      await sleep(100);
    }
    if (service.exitCode === null && service.signalCode === null) {
      service.kill();
      throw new Error(`service still running after stop:\n${serviceLog}`);
    }
    ok(
      `service exited (code ${service.exitCode ?? `signal ${service.signalCode}`}) ` +
        'and the port is closed',
    );

    process.stdout.write('\nALL SMOKE CHECKS PASSED\n');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nSMOKE FAILED: ${detail}\n`);
    if (serviceLog) process.stderr.write(`--- service log ---\n${serviceLog}\n`);
    process.exitCode = 1;
  } finally {
    mcp?.kill();
    if (service && service.exitCode === null && service.signalCode === null) {
      service.kill();
      await new Promise<void>((res) => {
        const fallback = setTimeout(res, 5_000);
        service!.once('exit', () => {
          clearTimeout(fallback);
          res();
        });
      });
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // temp-dir cleanup is best effort (a just-killed process may hold it briefly)
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`SMOKE FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
