import pino from 'pino';
import { basename, dirname, join, parse } from 'node:path';
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
  const fsRoot = parse(dir).root;
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'AGENTS.md'))) {
      return join(dir, 'logs');
    }
    if (dir === fsRoot) break;
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

// Lazily-initialised base logger shared by every module. All modules call
// createLogger(bindings) which returns base.child(bindings), so all output goes
// to the same pino.destination on LOG_FILE — one file, no duplicate file handles.
let baseLogger: pino.Logger | null = null;

function getBaseLogger(): pino.Logger {
  if (!baseLogger) {
    ensureLogDir();
    baseLogger = pino(
      {
        level: process.env.LOG_LEVEL || 'info',
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.destination({ dest: LOG_FILE, mkdir: true }),
    );
  }
  return baseLogger;
}

/**
 * Create a standalone pino logger (for MCP adapter and CLI, which are not
 * Fastify instances). Writes to the same `LOG_FILE` as Fastify so all
 * components share one log file. Returns base.child(bindings) so all modules
 * share the single underlying destination.
 */
export function createLogger(bindings?: Record<string, unknown>): pino.Logger {
  const base = getBaseLogger();
  return bindings ? base.child(bindings) : base;
}

/** A default logger with no bindings, for use outside request context. Lazily
 *  initialized on first use so importing this module does not create a pino
 *  destination (and register a SonicBoom exit handler) until something is
 *  actually logged — otherwise `workjournal --help` crashes on exit because
 *  `process.exit()` triggers SonicBoom.flushSync() on a not-ready stream. */
let _defaultLogger: pino.Logger | null = null;
export function getDefaultLogger(): pino.Logger {
  if (!_defaultLogger) _defaultLogger = createLogger();
  return _defaultLogger;
}

export const logger = new Proxy({} as pino.Logger, {
  get(_, prop: keyof pino.Logger) {
    return Reflect.get(getDefaultLogger(), prop);
  },
}) as pino.Logger;

/** Create a child logger with stable context fields (e.g. prompt name, action). */
export function child(bindings: Record<string, unknown>): pino.Logger {
  return createLogger(bindings);
}
