import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAutoStopConfig, startIdleSweeper, type IdleSweeper } from '@workjournal/core';

/**
 * Decision D-013: the auto-stopped service is the one the MCP adapter
 * started (WORKJOURNAL_AUTOSTART=1), and it stops itself once no adapter
 * heartbeat has been fresh for the idle window. Short real timers here —
 * production defaults (300s/60s/90s) are asserted at the config level only.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('loadAutoStopConfig', () => {
  it('is disabled unless the service was auto-started by the MCP adapter', () => {
    expect(loadAutoStopConfig({}).enabled).toBe(false);
    expect(loadAutoStopConfig({ WORKJOURNAL_AUTOSTART: '0' }).enabled).toBe(false);
    expect(loadAutoStopConfig({ WORKJOURNAL_AUTOSTART: 'true' }).enabled).toBe(false);
    expect(loadAutoStopConfig({ WORKJOURNAL_AUTOSTART: '1' }).enabled).toBe(true);
  });

  it('defaults to 300s idle, 60s poll, 90s fresh', () => {
    expect(loadAutoStopConfig({ WORKJOURNAL_AUTOSTART: '1' })).toEqual({
      enabled: true,
      idleMs: 300_000,
      pollMs: 60_000,
      freshMs: 90_000,
    });
  });

  it('accepts second-based overrides, including fractional values', () => {
    const config = loadAutoStopConfig({
      AUTO_STOP_IDLE_SECONDS: '5',
      AUTO_STOP_POLL_SECONDS: '0.5',
      AUTO_STOP_FRESH_SECONDS: '3',
    });
    expect(config).toMatchObject({ idleMs: 5_000, pollMs: 500, freshMs: 3_000 });
  });

  it('rejects non-positive or non-numeric values with an actionable error', () => {
    expect(() => loadAutoStopConfig({ AUTO_STOP_IDLE_SECONDS: 'soon' })).toThrow(
      /AUTO_STOP_IDLE_SECONDS must be a positive number/,
    );
    expect(() => loadAutoStopConfig({ AUTO_STOP_POLL_SECONDS: '0' })).toThrow(/positive number/);
  });
});

describe('startIdleSweeper (last-one-out)', () => {
  let home: string;
  let sweeper: IdleSweeper | null = null;
  let fires = 0;
  const onIdle = (): void => {
    fires += 1;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wjsweep-'));
    fires = 0;
  });

  afterEach(() => {
    sweeper?.stop();
    sweeper = null;
    rmSync(home, { recursive: true, force: true });
  });

  const writeHeartbeat = (name = '4242.json'): string => {
    const dir = join(home, 'mcp-heartbeats');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify({ pid: 4242 }));
    return file;
  };

  it('never fires when the service was not auto-started (gate on the flag)', async () => {
    sweeper = startIdleSweeper({
      homeDir: home,
      config: { enabled: false, idleMs: 100, pollMs: 30, freshMs: 80 },
      onIdle,
    });
    await sleep(350);
    expect(fires).toBe(0);
  });

  it('fires exactly once after the idle window with no client heartbeat', async () => {
    sweeper = startIdleSweeper({
      homeDir: home,
      config: { enabled: true, idleMs: 150, pollMs: 40, freshMs: 100 },
      onIdle,
    });
    await sleep(500);
    expect(fires).toBe(1);
    await sleep(200); // the interval is cleared before onIdle — no re-fire
    expect(fires).toBe(1);
  });

  it('stays quiet while a client refreshes its heartbeat, fires after it dies', async () => {
    const file = writeHeartbeat();
    sweeper = startIdleSweeper({
      homeDir: home,
      config: { enabled: true, idleMs: 200, pollMs: 40, freshMs: 120 },
      onIdle,
    });

    const refresher = setInterval(() => {
      const now = Date.now() / 1000;
      utimesSync(file, now, now);
    }, 50);
    await sleep(500);
    expect(fires).toBe(0); // heartbeat kept the idle clock resetting

    clearInterval(refresher);
    await sleep(800); // fresh window (120ms) passes, then idle (200ms) elapses
    expect(fires).toBe(1);
  }, 10_000);

  it('treats a missing heartbeat directory as "no clients"', async () => {
    // Adapter crashed before writing anything / brand-new home.
    sweeper = startIdleSweeper({
      homeDir: home,
      config: { enabled: true, idleMs: 120, pollMs: 40, freshMs: 80 },
      onIdle,
    });
    await sleep(400);
    expect(fires).toBe(1);
  });

  it('stop() halts watching without firing', async () => {
    sweeper = startIdleSweeper({
      homeDir: home,
      config: { enabled: true, idleMs: 100, pollMs: 30, freshMs: 60 },
      onIdle,
    });
    sweeper.stop();
    await sleep(300);
    expect(fires).toBe(0);
  });
});
