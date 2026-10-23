import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `workjournal status` (monitoring aid): the running line carries the current
 * PID from <home>/service.pid, and both PID-file mismatch cases are called
 * out instead of being silently reported — a stale file while the service
 * still answers, and an alive PID that does not. Real processes, real files,
 * no mocks. Runs against the BUILT CLI — run `pnpm build` first.
 */

const CLI_ENTRY = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));

/** An impossibly high PID (OSes allocate far below it) → guaranteed dead. */
const DEAD_PID = 2147483646;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Kill and WAIT — Windows keeps a just-killed core's files locked until it is gone. */
async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(fallback);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Core UP: the running line carries the current pid; mismatch cases follow
//    (the later tests mutate service.pid — declaration order matters, as in
//    the rest of the suite).
// ─────────────────────────────────────────────────────────────────────────────
describe('workjournal status against a running core', () => {
  let home: string;
  let base: string;
  let env: Record<string, string>;
  let service: ChildProcess;
  let servicePid: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'wj-status-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = {
      WORKJOURNAL_HOME: home,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
    };
    service = spawn(process.execPath, [CLI_ENTRY, 'start'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(await waitFor(() => healthy(base), 20_000), 'core failed to start').toBe(true);
    servicePid = readFileSync(join(home, 'service.pid'), 'utf-8').trim();
  }, 40_000);

  afterAll(async () => {
    await killAndWait(service);
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('reports the running service with its current pid', async () => {
    const res = await runCli(['status'], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`WorkJournal core service is running at ${base}`);
    expect(res.out).toContain(`(pid ${servicePid})`);
  }, 20_000);

  it('calls out a stale service.pid even while the service still answers', async () => {
    writeFileSync(join(home, 'service.pid'), String(DEAD_PID));
    const res = await runCli(['status'], env);
    expect(res.out).toContain(`running at ${base}`);
    expect(res.out).toContain(`stale service.pid: pid ${DEAD_PID} is not running`);
  }, 20_000);

  it('says pid unknown when a running core has no service.pid', async () => {
    unlinkSync(join(home, 'service.pid'));
    const res = await runCli(['status'], env);
    expect(res.out).toContain(`running at ${base}`);
    expect(res.out).toContain('pid unknown');
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Core DOWN: service.pid still tells the monitoring story.
// ─────────────────────────────────────────────────────────────────────────────
describe('workjournal status with the core down', () => {
  it('reports a stale pid file when nothing is running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-status-stale-'));
    try {
      writeFileSync(join(home, 'service.pid'), String(DEAD_PID));
      const res = await runCli(['status'], {
        WORKJOURNAL_HOME: home,
        HOST: '127.0.0.1',
        PORT: String(await freePort()),
        LOG_LEVEL: 'silent',
      });
      expect(res.out).toContain('WorkJournal core service is not running.');
      expect(res.out).toContain(`service.pid is stale: pid ${DEAD_PID} no longer exists.`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 20_000);

  it('reports an alive-but-unreachable pid (starting up, or PID reused)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wj-status-alive-'));
    try {
      // This test process is alive but is obviously not the core service.
      writeFileSync(join(home, 'service.pid'), String(process.pid));
      const res = await runCli(['status'], {
        WORKJOURNAL_HOME: home,
        HOST: '127.0.0.1',
        PORT: String(await freePort()),
        LOG_LEVEL: 'silent',
      });
      expect(res.out).toContain('WorkJournal core service is not running.');
      expect(res.out).toContain(`service.pid names pid ${process.pid}, which is alive but does not answer`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 20_000);
});
