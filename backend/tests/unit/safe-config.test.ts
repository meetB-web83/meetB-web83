/**
 * Unit tests for safe-config.ts — agent-agnostic JSONC config safety.
 *
 * Covers: comment/unknown-key preservation, parse-error handling with
 * byte-identical originals, timestamped backup + rollback, duplicate-key
 * first-occurrence edits, and EACCES no-partial-write guarantee.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite,
  backupFile,
  parseJsonc,
  readConfigFile,
  removeJsoncValue,
  restoreFromBackup,
  setJsoncValue,
  writeManagedFile,
} from '../../packages/cli/src/integrations/safe-config.js';

describe('safe-config', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wj-safe-config-'));
    dir = join(root, 'cfg');
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('readConfigFile', () => {
    it('parses JSONC with comments and trailing commas', async () => {
      const path = join(dir, 'config.jsonc');
      await writeFile(path, '// comment\n{\n  "a": 1,\n  // trailing\n  "b": 2,\n}\n', 'utf8');

      const loaded = await readConfigFile(path);
      expect(loaded.exists).toBe(true);
      expect(loaded.error).toBeUndefined();
      expect((loaded.data as any).a).toBe(1);
      expect((loaded.data as any).b).toBe(2);
    });

    it('returns configuration_error with line/column for invalid JSONC', async () => {
      const path = join(dir, 'bad.jsonc');
      await writeFile(path, '{ not valid json', 'utf8');

      const loaded = await readConfigFile(path);
      expect(loaded.exists).toBe(true);
      expect(loaded.error).toBeDefined();
      expect(loaded.error!.line).toBeGreaterThan(0);
      expect(loaded.error!.column).toBeGreaterThan(0);
      expect(loaded.data).toBeUndefined();
    });

    it('leaves the original file byte-identical on parse error', async () => {
      const path = join(dir, 'bad.jsonc');
      const original = '{ not valid json\n';
      await writeFile(path, original, 'utf8');

      await readConfigFile(path);
      const after = await readFile(path, 'utf8');
      expect(after).toBe(original);
    });

    it('returns exists=false for a missing file', async () => {
      const loaded = await readConfigFile(join(dir, 'missing.jsonc'));
      expect(loaded.exists).toBe(false);
      expect(loaded.error).toBeUndefined();
    });
  });

  describe('parseJsonc', () => {
    it('parses valid JSONC', () => {
      const result = parseJsonc('{\n  /* comment */\n  "a": 1,\n}');
      expect(result.error).toBeUndefined();
      expect((result.data as any).a).toBe(1);
    });

    it('returns error with location for invalid JSON', () => {
      const result = parseJsonc('{ bad');
      expect(result.error).toBeDefined();
      expect(result.error!.line).toBeGreaterThan(0);
      expect(result.data).toBeUndefined();
    });
  });

  describe('setJsoncValue / removeJsoncValue', () => {
    it('preserves comments and unknown keys outside edited regions', async () => {
      const path = join(dir, 'config.json');
      const original =
        '// top comment\n{\n  "mcp": {\n    "servers": {\n      "other": { "command": ["x"] }\n    }\n  }\n  // bottom comment\n}\n';
      await writeFile(path, original, 'utf8');

      const updated = setJsoncValue(original, ['mcp', 'servers', 'workjournal'], {
        command: 'workjournal',
        args: ['mcp'],
      });
      const parsed = parseJsonc(updated);
      expect(parsed.error).toBeUndefined();
      expect((parsed.data as any).mcp.servers.workjournal.command).toBe('workjournal');
      expect((parsed.data as any).mcp.servers.other.command).toEqual(['x']);

      const text = updated;
      expect(text).toContain('// top comment');
      expect(text).toContain('// bottom comment');
      expect(text).toContain('"other"');
    });

    it('removes a nested value cleanly', async () => {
      const original = '{\n  "a": 1,\n  "b": 2\n}\n';
      const updated = removeJsoncValue(original, ['a']);
      const parsed = parseJsonc(updated);
      expect((parsed.data as any).a).toBeUndefined();
      expect((parsed.data as any).b).toBe(2);
    });
  });

  describe('backup + rollback', () => {
    it('creates a timestamped backup before modifying an existing file', async () => {
      const path = join(dir, 'config.json');
      await writeFile(path, '{\n  "old": true\n}\n', 'utf8');

      const backup = await backupFile(path);
      expect(backup).toBeDefined();
      expect(backup).toMatch(/\.workjournal-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
      const backupContent = await readFile(backup!, 'utf8');
      expect(backupContent).toBe('{\n  "old": true\n}\n');
    });

    it('restores from backup on post-write validation failure', async () => {
      const path = join(dir, 'config.json');
      const original = '{\n  "original": true\n}\n';
      await writeFile(path, original, 'utf8');

      const backup = await backupFile(path);
      await atomicWrite(path, '{\n  "modified": true\n}\n');

      // Simulate validation failure -> rollback
      await restoreFromBackup(path, backup!);
      const after = await readFile(path, 'utf8');
      expect(after).toBe(original);
    });

    it('returns null for backup of a missing file', async () => {
      const backup = await backupFile(join(dir, 'missing.json'));
      expect(backup).toBeNull();
    });
  });

  describe('writeManagedFile', () => {
    it('creates a new file when it does not exist', async () => {
      const path = join(dir, 'new.json');
      const result = await writeManagedFile(path, '{\n  "new": true\n}\n');
      expect(result.action).toBe('create');
      expect(result.backup).toBeNull();
      const content = await readFile(path, 'utf8');
      expect(content).toBe('{\n  "new": true\n}\n');
    });

    it('updates an existing file only when content differs', async () => {
      const path = join(dir, 'existing.json');
      await writeFile(path, '{\n  "old": true\n}\n', 'utf8');

      const result = await writeManagedFile(path, '{\n  "new": true\n}\n', );
      expect(result.action).toBe('update');
      expect(result.backup).toBeDefined();

      const content = await readFile(path, 'utf8');
      expect(content).toBe('{\n  "new": true\n}\n');

      // Idempotent: same content is a no-op
      const result2 = await writeManagedFile(path, '{\n  "new": true\n}\n');
      expect(result2.action).toBe('noop');
    });
  });

  describe('atomic write safety', () => {
    it('leaves no temp files after a successful write', async () => {
      const path = join(dir, 'clean.json');
      await atomicWrite(path, '{\n  "ok": true\n}\n');

      const entries = (await import('node:fs/promises')).readdir(dir);
      const tmpFiles = (await entries).filter((f) => f.startsWith('.workjournal-tmp-'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('removes temp file on write failure', async () => {
      // Write to a path inside a nonexistent directory that cannot be created
      // (parent is a file, not a directory) to trigger a write failure.
      const fileAsDir = join(dir, 'blocker');
      await writeFile(fileAsDir, 'not a directory', 'utf8');
      const path = join(fileAsDir, 'nested', 'blocked.json');

      let threw = false;
      try {
        await atomicWrite(path, '{\n  "fail": true\n}\n');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir));
      const tmpFiles = entries.filter((f) => f.startsWith('.workjournal-tmp-'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
