import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServer,
  loadUiAssetsFromDir,
  uiAssetsFromFiles,
  embeddedUiAssets,
  type Database,
  type Config,
} from '@workjournal/core';
import { createRegistryDb } from '../helpers/registry-factory.js';

/**
 * Same-origin dashboard serving (plan Phase 1): when buildServer receives UI
 * assets, the core service serves the SPA and the API from one port:
 *  - exact asset match (hashed /assets/* get immutable caching)
 *  - unknown client-side routes → index.html (SPA fallback)
 *  - unknown /api routes → JSON 404, never HTML
 *  - without UI assets the service stays API-only, exactly as before.
 */
describe('Dashboard served from the core service (same origin)', () => {
  let registry: ReturnType<typeof createRegistryDb>;
  let server: ReturnType<typeof buildServer>;
  let fixtureDir: string;

  const config: Config = {
    workjournalHome: '~/.workjournal-ui-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const INDEX_HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';

  beforeAll(async () => {
    registry = createRegistryDb();

    fixtureDir = mkdtempSync(join(tmpdir(), 'workjournal-ui-'));
    writeFileSync(join(fixtureDir, 'index.html'), INDEX_HTML);
    mkdirSync(join(fixtureDir, 'assets'));
    writeFileSync(join(fixtureDir, 'assets', 'app-abc123.js'), 'console.log("hi")');
    writeFileSync(join(fixtureDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const ui = loadUiAssetsFromDir(fixtureDir);
    server = buildServer(registry.db, config, { ui });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    registry?.cleanup();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('serves index.html at /', async () => {
    const res = await server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<div id="root">');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets with immutable caching and correct content types', async () => {
    const res = await server.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const svg = await server.inject({ method: 'GET', url: '/favicon.svg' });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    // Not under assets/ → revalidated every load
    expect(svg.headers['cache-control']).toBe('no-cache');
  });

  it('falls back to index.html for client-side routes', async () => {
    for (const url of ['/projects/deep/route', '/settings', '/tasks']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<div id="root">');
    }
  });

  it('returns JSON 404 for unknown API routes, never HTML', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    const payload = JSON.parse(res.body);
    expect(payload.error).toBe('NOT_FOUND');
    expect(res.body).not.toContain('<div id="root">');
  });

  it('returns JSON 404 for unknown file-like paths (stale bundles)', async () => {
    const res = await server.inject({ method: 'GET', url: '/assets/gone-999.js' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('<div id="root">');
  });

  it('keeps /health and the API working alongside the UI', async () => {
    const health = await server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });

    const projects = await server.inject({ method: 'GET', url: '/api/projects' });
    expect(projects.statusCode).toBe(200);
    expect(projects.headers['content-type']).toContain('application/json');
    expect(JSON.parse(projects.body)).toBeInstanceOf(Array);
  });
});

describe('API-only server (no UI assets) is unchanged', () => {
  it('404s / with JSON, not HTML', async () => {
    const registry = createRegistryDb();
    const config: Config = {
      workjournalHome: '~/.workjournal-ui-test',
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      nodeEnv: 'test',
    };
    const server = buildServer(registry.db, config);
    await server.ready();

    const res = await server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('<div id="root">');

    await server.close();
    registry.cleanup();
  });
});

describe('UI asset loaders', () => {
  it('loadUiAssetsFromDir throws an actionable error for a missing directory', () => {
    expect(() => loadUiAssetsFromDir(join(tmpdir(), 'workjournal-nope-does-not-exist')))
      .toThrowError(/Dashboard directory not found/);
  });

  it('loadUiAssetsFromDir rejects a directory without index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workjournal-ui-noindex-'));
    try {
      writeFileSync(join(dir, 'app.js'), 'x');
      expect(() => loadUiAssetsFromDir(dir)).toThrowError(/No index\.html/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uiAssetsFromFiles rejects a set without index.html', () => {
    expect(() => uiAssetsFromFiles({ 'a.js': { contentType: 'text/javascript', base64: 'eA==' } }))
      .toThrowError(/no index\.html/);
  });

  it('embeddedUiAssets() returns null or a valid set, and never throws', () => {
    // Generated by scripts/embed-ui.ts: populated when the frontend was built
    // at embed time, null otherwise (fresh clone without frontend build).
    const embedded = embeddedUiAssets();
    if (embedded !== null) {
      expect(embedded.indexHtml).toContain('<div');
      expect(Object.keys(embedded.files).length).toBeGreaterThan(0);
      expect(embedded.files['index.html']).toBeDefined();
    }
  });
});
