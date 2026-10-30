import pino from 'pino';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Determine the log directory.
 * Priority:
 *  1. WORKJOURNAL_LOG_DIR env var (explicit override)
 *  2. Running as the SEA executable → sibling `logs/` folder next to the exe
 *  3. Development → repo root `logs/` folder (walk up from here to find .git/AGENTS.md)
 */
export function getLogDir(): string {
  const override = process.env.WORKJOURNAL_LOG_DIR;
  if (override) return override;

  const exeBase = basename(process.execPath);
  if (/^workjournal(\.exe)?$/i.test(exeBase)) {
    return join(dirname(process.execPath), 'logs');
  }

  // Development: walk up from this file's location to find the repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  const fsRoot = dirname(dir);
  while (dir !== fsRoot) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'AGENTS.md'))) {
      return join(dir, 'logs');
    }
    dir = dirname(dir);
  }
  return join(process.cwd(), 'logs');
}

/** The log file path — one file, appended to, never rotated in Release 1. */
export const LOG_FILE = join(getLogDir(), 'workjournal.log');

/**
 * Ensure the log directory exists before the first write.
 * Safe to call multiple times.
 */
export function ensureLogDir(): void {
  mkdirSync(getLogDir(), { recursive: true });
}

/**
 * Pino logger configuration object for Fastify's `logger` option.
 * Fastify supports the `file` option which internally uses `pino.destination()`
 * to write JSON lines to `LOG_FILE`.
 *
 * Database queries are intentionally NOT logged — this logger is for service
 * lifecycle, prompt notifications, MCP sync, and actionable errors only.
 */
export function getPinoConfig(): Record<string, unknown> {
  ensureLogDir();
  return {
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    // `file` is a Fastify-specific option (not in pino's type) that tells
    // Fastify to use `pino.destination()` to write to this file.
    file: LOG_FILE,
  };
}

/**
 * Create a standalone pino logger (for MCP adapter and CLI, which are not
 * Fastify instances). Writes to the same `LOG_FILE` as Fastify so all
 * components share one log file.
 */
export function createLogger(bindings?: Record<string, unknown>): pino.Logger {
  ensureLogDir();

  const base = pino(
    {
      level: process.env.LOG_LEVEL || 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: LOG_FILE, mkdir: true }),
  );

  return bindings ? base.child(bindings) : base;
}

/** A default logger with no bindings, for use outside request context. */
export const logger = createLogger();

/** Create a child logger with stable context fields (e.g. prompt name, action). */
export function child(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
