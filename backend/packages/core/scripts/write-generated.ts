/**
 * Shared writer for the committed codegen outputs (`embedded-ui.generated.ts`,
 * `embedded-migrations.generated.ts`).
 *
 * A plain `writeFileSync` intermittently fails on Windows with
 * `UNKNOWN: unknown error, open '<file>'` (errno -4094) because another process
 * — antivirus, OneDrive, an editor, or a concurrent `tsx watch` — holds the
 * destination open without FILE_SHARE_WRITE. That aborted `pnpm build` (and
 * therefore `pnpm build:exe`) after the frontend was rebuilt.
 *
 * Two mitigations: skip the write when the content is byte-identical (most
 * rebuilds change nothing here), and otherwise stage to a sibling temp file and
 * rename over the target, retrying a few times before giving up.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeGeneratedFile(outFile: string, content: string): { changed: boolean } {
  if (existsSync(outFile) && readFileSync(outFile, 'utf-8') === content) {
    return { changed: false };
  }

  const tmpFile = join(dirname(outFile), `.${basename(outFile)}.${process.pid}.tmp`);
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      writeFileSync(tmpFile, content);
      renameSync(tmpFile, outFile);
      return { changed: true };
    } catch (err) {
      lastError = err;
      try {
        unlinkSync(tmpFile);
      } catch {
        // temp file may not exist yet, or is itself briefly locked
      }
      if (attempt < MAX_ATTEMPTS - 1) sleepSync(BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}
