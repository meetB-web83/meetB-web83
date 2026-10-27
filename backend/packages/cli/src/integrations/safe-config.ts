/**
 * Agent-agnostic config I/O (plan §10.4, D-021).
 *
 * JSONC files are parsed and edited with `jsonc-parser` so comments,
 * formatting, and unrelated keys survive. Writes are mkdir + temp-file +
 * rename, and every modification of an existing file is preceded by a
 * timestamped backup. Errors are never swallowed by this module; callers
 * decide whether a failure is fatal.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';

const FORMATTING: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

export interface ConfigParseError {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  text: string;
  data: unknown;
  error?: ConfigParseError;
}

/** Read and parse a JSONC file. A missing file is not an error. */
export async function readConfigFile(filePath: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { path: filePath, exists: false, text: '', data: {} };
    }
    throw err;
  }

  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    const { line, column } = offsetToLineColumn(text, first.offset);
    return {
      path: filePath,
      exists: true,
      text,
      data: undefined,
      error: {
        message: `${printParseErrorCode(first.error)} at line ${line}, column ${column}`,
        offset: first.offset,
        line,
        column,
      },
    };
  }
  return { path: filePath, exists: true, text, data };
}

/** Parse JSONC text, returning the same error shape as readConfigFile. */
export function parseJsonc(text: string): { data?: unknown; error?: ConfigParseError } {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    const { line, column } = offsetToLineColumn(text, first.offset);
    return {
      error: {
        message: `${printParseErrorCode(first.error)} at line ${line}, column ${column}`,
        offset: first.offset,
        line,
        column,
      },
    };
  }
  return { data };
}

/** Set a nested JSONC value, creating parents as needed and preserving comments. */
export function setJsoncValue(text: string, path: Array<string | number>, value: unknown): string {
  const base = text.trim().length > 0 ? text : '{\n}\n';
  const edits = modify(base, path, value, { formattingOptions: FORMATTING });
  return ensureTrailingNewline(applyEdits(base, edits));
}

/** Remove a nested JSONC value. A missing path is a no-op. */
export function removeJsoncValue(text: string, path: Array<string | number>): string {
  if (text.trim().length === 0) return text;
  const edits = modify(text, path, undefined, { formattingOptions: FORMATTING });
  if (edits.length === 0) return ensureTrailingNewline(text);
  return ensureTrailingNewline(applyEdits(text, edits));
}

export function getAtPath(data: unknown, path: Array<string | number>): unknown {
  let current: any = data;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key as any];
  }
  return current;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/** Create a timestamped backup of a file. Returns the backup path, or null if missing. */
export async function backupFile(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.workjournal-backup-${timestamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

/** Atomic write: ensure the parent directory, write a temp file, then rename. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.workjournal-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface WriteManagedResult {
  action: 'create' | 'update' | 'noop';
  backup: string | null;
}

/** Write only when content differs; back up an existing file first. */
export async function writeManagedFile(filePath: string, content: string): Promise<WriteManagedResult> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (existing === content) {
    return { action: 'noop', backup: null };
  }
  const backup = existing === null ? null : await backupFile(filePath);
  await atomicWrite(filePath, content);
  return { action: existing === null ? 'create' : 'update', backup };
}

/** Restore a file from its backup (used for post-write rollback). */
export async function restoreFromBackup(filePath: string, backupPath: string): Promise<void> {
  await atomicWrite(filePath, await fs.readFile(backupPath, 'utf8'));
  await fs.rm(backupPath, { force: true }).catch(() => undefined);
}

export async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const prefix = text.slice(0, Math.max(0, offset));
  const lines = prefix.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}
