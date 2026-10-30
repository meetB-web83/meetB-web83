import { describe, it, expect } from 'vitest';
import { getLogDir, LOG_FILE } from '@workjournal/shared';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 6 test: getLogDir resolves to <repo-root>/logs regardless of cwd,
 * and WORKJOURNAL_LOG_DIR overrides it.
 */
describe('getLogDir', () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  // backend/tests/ → backend/ → repo root
  const repoRoot = join(HERE, '../../');
  const expectedLogsDir = join(repoRoot, 'logs');

  it('resolves to <repo-root>/logs by default', () => {
    // Temporarily override env to ensure dev path detection.
    const prev = process.env.WORKJOURNAL_LOG_DIR;
    delete process.env.WORKJOURNAL_LOG_DIR;
    try {
      const dir = getLogDir();
      expect(dir).toBe(expectedLogsDir);
    } finally {
      if (prev !== undefined) process.env.WORKJOURNAL_LOG_DIR = prev;
      else delete process.env.WORKJOURNAL_LOG_DIR;
    }
  });

  it('LOG_FILE is join(getLogDir(), workjournal.log)', () => {
    expect(LOG_FILE).toBe(join(expectedLogsDir, 'workjournal.log'));
  });

  it('WORKJOURNAL_LOG_DIR overrides the default', () => {
    const prev = process.env.WORKJOURNAL_LOG_DIR;
    process.env.WORKJOURNAL_LOG_DIR = '/tmp/custom-logs';
    try {
      expect(getLogDir()).toBe('/tmp/custom-logs');
    } finally {
      if (prev !== undefined) process.env.WORKJOURNAL_LOG_DIR = prev;
      else delete process.env.WORKJOURNAL_LOG_DIR;
    }
  });
});
