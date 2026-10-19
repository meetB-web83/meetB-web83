import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProjectDbResolver,
  createDatabase,
  projectDbPath,
  normalizeRootPath,
  type Database,
} from '@workjournal/core';
import { createRegistryDb, tempProjectRoot, PROJECT_MIGRATIONS_DIR } from '../helpers/registry-factory.js';

/**
 * Spec §9.1–2: per-project storage. A project rooted at a real folder gets its own DB
 * under `<root>/.workjournal/`; a second open is idempotent; a deleted folder reads as
 * "unavailable" rather than a raw crash; the project row lives in both DBs and the
 * project DB copy follows a registry rename.
 */
describe('Per-project storage', () => {
  let registry: Database;
  let cleanupRegistry: () => void;
  let projectRoot: string;
  let resolver: ProjectDbResolver;

  const registerProject = (id: string, name: string, rootPath: string) => {
    const now = new Date().toISOString();
    registry.raw
      .prepare(
        'INSERT INTO registry_projects (id, name, description, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, null, rootPath, now, now);
  };

  beforeEach(() => {
    const reg = createRegistryDb();
    registry = reg.db;
    cleanupRegistry = reg.cleanup;
    projectRoot = tempProjectRoot();
    resolver = new ProjectDbResolver(registry, PROJECT_MIGRATIONS_DIR);
    registerProject('proj-1', 'Demo', projectRoot);
  });

  afterEach(() => {
    resolver.closeAll();
    cleanupRegistry();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates <root>/.workjournal/workjournal.db with all six tables', () => {
    resolver.forProject('proj-1');

    const dbPath = projectDbPath(projectRoot);
    expect(existsSync(dbPath)).toBe(true);

    // Reopen the file directly to prove the schema is really on disk.
    const reopened = createDatabase(dbPath);
    const tables = new Set(
      reopened.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r: any) => r.name),
    );
    for (const table of ['projects', 'tasks', 'events', 'checkpoints', 'decisions', 'idempotency_records']) {
      expect(tables.has(table)).toBe(true);
    }
    reopened.raw.close();
  });

  it('a second open is idempotent', () => {
    const first = resolver.forProject('proj-1');
    const second = resolver.forProject('proj-1');
    expect(second).toBe(first);

    // A fresh resolver over the existing file must not fail or duplicate the schema.
    const fresh = new ProjectDbResolver(registry, PROJECT_MIGRATIONS_DIR);
    const db2 = fresh.forProject('proj-1');
    const taskTables = db2.raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as any;
    expect(taskTables.n).toBe(1);
    fresh.closeAll();
  });

  it('keeps the project row consistent between registry and project DB across a rename', () => {
    const db = resolver.forProject('proj-1');
    const row = db.raw.prepare('SELECT * FROM projects WHERE id = ?').get('proj-1') as any;
    expect(row.name).toBe('Demo');
    expect(row.root_path).toBe(projectRoot);

    registry.raw.prepare('UPDATE registry_projects SET name = ? WHERE id = ?').run('Renamed', 'proj-1');
    resolver.refreshIfOpen('proj-1');

    const synced = db.raw.prepare('SELECT name FROM projects WHERE id = ?').get('proj-1') as any;
    expect(synced.name).toBe('Renamed');
  });

  it('reports a missing project folder as unavailable instead of a raw error', () => {
    registerProject('proj-2', 'Ghost', join(projectRoot, 'does-not-exist'));

    expect(() => resolver.forProject('proj-2')).toThrow(/unavailable/i);

    const available = resolver.availableProjects().map((p: any) => p.id);
    expect(available).toContain('proj-1');
    expect(available).not.toContain('proj-2');
  });

  it('never creates files while scanning for records', () => {
    registerProject('proj-3', 'Ghost Two', join(projectRoot, 'also-missing'));

    expect(() => resolver.forTask('no-such-task')).toThrow(/not found/i);
    expect(existsSync(join(projectRoot, 'also-missing'))).toBe(false);
  });
});

describe('normalizeRootPath', () => {
  it('converts git-style drive paths on win32 only', () => {
    if (process.platform === 'win32') {
      expect(normalizeRootPath('/c/Users/test')).toBe('C:/Users/test');
      expect(normalizeRootPath('/d/a/b')).toBe('D:/a/b');
    } else {
      expect(normalizeRootPath('/c/Users/test')).toBe('/c/Users/test');
    }
  });

  it('leaves native paths alone', () => {
    expect(normalizeRootPath(projectRootNative())).toBe(projectRootNative());
  });
});

function projectRootNative(): string {
  // Stable native-looking path that needs no normalization on any platform.
  return process.platform === 'win32' ? 'C:\\somewhere\\project' : '/somewhere/project';
}
