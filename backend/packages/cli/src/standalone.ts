import { createCliProgram } from './program.js';

/**
 * Entry point bundled into the single-file SEA executable (`dist-bin/workjournal`,
 * decision D-011).
 *
 * `backend/scripts/build-exe.ts` esbuild-bundles this file (from the tsc-built
 * `dist/`) into one CommonJS file that `node --experimental-sea-config` turns
 * into the blob injected into a copy of `node.exe`. Consequences for this
 * module and everything it imports:
 *
 *  - no top-level await: CommonJS output cannot express it, so dispatch uses
 *    `parseAsync` with an explicit failure exit instead of awaiting at module
 *    scope (this is why the shared program lives in `program.ts` and the
 *    adapter's TLA `index.ts` is never part of the import graph — `mcp.ts`
 *    imports the adapter's `/stdio` and `/http-server` subpaths);
 *  - no reliance on files next to the executable: migrations and dashboard
 *  - assets come from the embedded generated modules (core's
 *    `migrations-source.ts` / `ui-assets.ts` fall back to them when no
 *    `import.meta.dirname` is available).
 *
 * Dispatch itself is the same commander program as `index.ts`.
 */
createCliProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
