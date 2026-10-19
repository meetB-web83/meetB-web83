import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MigrationFile } from './migrate.js';
import {
  embeddedRegistryMigrations,
  embeddedProjectMigrations,
} from './embedded-migrations.generated.js';

/**
 * Migration sources that work in every packaging mode (D-011):
 *
 *  - tsc/tsx runs (dev, Docker, native CLI): the real `.sql` directories sit
 *    next to the package, so they are read from disk — source-tree migration
 *    edits apply without a rebuild.
 *  - the single-file SEA executable: no files exist next to the binary, so the
 *    arrays embedded at build time by `scripts/embed-migrations.ts` are used.
 *
 * Both forms are generated from the same committed `.sql` files, so the
 * `__migrations` ledger is identical either way.
 */

/** Directory of this module at runtime, or undefined inside a bundle. */
function moduleDir(): string | undefined {
  return typeof import.meta.dirname === 'string' ? import.meta.dirname : undefined;
}

function fromDiskOrEmbedded(
  diskDir: string | undefined,
  embedded: MigrationFile[],
  what: string,
): string | MigrationFile[] {
  if (diskDir && existsSync(diskDir)) return diskDir;
  if (embedded.length > 0) return embedded;
  throw new Error(
    `No ${what} found${diskDir ? ` at ${diskDir}` : ' (bundled binary)'} and none embedded in ` +
      `this build. Rebuild with \`pnpm build\` (it re-runs the embed step).`,
  );
}

/** Registry migrations: `<core>/migrations` on disk, else the embedded copy. */
export function registryMigrationsSource(): string | MigrationFile[] {
  const dir = moduleDir();
  return fromDiskOrEmbedded(
    dir ? resolve(dir, '../../migrations') : undefined,
    embeddedRegistryMigrations(),
    'registry migrations',
  );
}

/** Project migrations: `<core>/project-migrations` on disk, else embedded. */
export function projectMigrationsSource(): string | MigrationFile[] {
  const dir = moduleDir();
  return fromDiskOrEmbedded(
    dir ? resolve(dir, '../../project-migrations') : undefined,
    embeddedProjectMigrations(),
    'project migrations',
  );
}
