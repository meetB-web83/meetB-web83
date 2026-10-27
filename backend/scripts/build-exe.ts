/**
 * Build `dist-bin/workjournal(.exe)` — the single-file WorkJournal executable
 * (decision D-011). Run as `pnpm build:exe` from `backend/`.
 *
 * Chain (each step must succeed for the next to be meaningful):
 *   0. fail fast when `frontend/dist/index.html` is missing — the embed step
 *      would silently emit a null UI and the exe would build API-only;
 *   1. `pnpm build` — codegen (embed-ui + embed-migrations) then tsc for all
 *      workspace packages, so the bundle always comes from fresh dist output;
 *   2. esbuild: bundle `packages/cli/dist/standalone.js` into ONE CommonJS
 *      file (`dist-bin/workjournal.bundle.cjs`). Node builtins stay external
 *      (platform: node); `import.meta.dirname` is defined to `undefined` so
 *      `migrations-source.ts` falls through to the embedded migration arrays
 *      and the build stays warning-free — any OTHER `import.meta` use would
 *      still warn (empty-import-meta) and must be fixed, not silenced;
 *   3. `node --experimental-sea-config` on `dist-bin/sea-config.json` →
 *      `workjournal.blob` (run with cwd = dist-bin, relative names);
 *   4. copy the running `node.exe` (process.execPath) → `dist-bin/workjournal(.exe)`;
 *   5. postject: inject the blob as `NODE_SEA_BLOB` with the Node SEA sentinel
 *      fuse (plus `--macho-segment-name NODE_SEA` off Windows);
 *   6. "refreeze" = the docs' signature steps, both optional: best-effort
 *      signature removal before injection and re-sign after it when the
 *      platform tool exists (codesign on macOS, signtool on Windows). Without
 *      signtool (the common case here) both are logged as skipped — postject's
 *      "signature seems corrupted" warning about node.exe's stale Authenticode
 *      signature is then expected and harmless (proven by the SEA spike: the
 *      binary runs and node:sqlite queries succeed).
 */
import { execSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url)); // backend/scripts/
const backendRoot = resolve(here, '..');
const repoRoot = resolve(backendRoot, '..');
const distBin = join(backendRoot, 'dist-bin');
const entry = join(backendRoot, 'packages', 'cli', 'dist', 'standalone.js');
const bundlePath = join(distBin, 'workjournal.bundle.cjs');
const configPath = join(distBin, 'sea-config.json');
const blobPath = join(distBin, 'workjournal.blob');
const exeName = process.platform === 'win32' ? 'workjournal.exe' : 'workjournal';
const exePath = join(distBin, exeName);

/**
 * `jsonc-parser`'s `main` is a UMD file that calls `require("./impl/format")`
 * through a variable, so esbuild cannot inline it; inside the SEA blob that
 * dynamic require is looked up as a builtin and the exe dies at startup with
 * ERR_UNKNOWN_BUILTIN_MODULE. Point the bundler at the package's ESM entry
 * instead, which uses static imports.
 */
const jsoncEsmEntry = createRequire(join(backendRoot, 'packages', 'cli', 'package.json')).resolve(
  'jsonc-parser/lib/esm/main.js',
);

/** Node SEA sentinel fuse — must match what postject embeds and Node checks. */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(message: string): void {
  process.stdout.write(`[build-exe] ${message}\n`);
}

/** Run a shell command in a directory, inheriting stdio (fails loudly). */
function sh(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: 'inherit' });
}

function commandExists(command: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${command}` : `command -v ${command}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // ── 0. Precondition: a built frontend so the dashboard gets embedded ──
  const frontendIndex = join(repoRoot, 'frontend', 'dist', 'index.html');
  if (!existsSync(frontendIndex)) {
    throw new Error(
      `frontend/dist/index.html not found (${frontendIndex}). The SEA executable serves the ` +
        'dashboard from embedded assets, so build the frontend first:\n' +
        '  cd frontend && pnpm install && pnpm build',
    );
  }

  // ── 1. Codegen + tsc for the whole workspace ──
  log('pnpm build (embed codegen + tsc) …');
  sh('pnpm build', backendRoot);

  // ── 2. Clean dist-bin (a locked exe means a service is still running) ──
  try {
    rmSync(distBin, { recursive: true, force: true });
  } catch (err) {
    throw new Error(
      `Cannot clean ${distBin} (${String(err)}). Stop any running WorkJournal service ` +
        '(`workjournal stop`) or close the executable and retry.',
    );
  }
  mkdirSync(distBin, { recursive: true });

  // ── 3. esbuild: one CJS file with the whole application graph ──
  if (!existsSync(entry)) {
    throw new Error(`Bundle entry missing: ${entry} — did \`pnpm build\` succeed?`);
  }
  log('esbuild: bundling the CLI (CJS, node platform) …');
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: { 'import.meta.dirname': 'undefined' },
    alias: { 'jsonc-parser': jsoncEsmEntry },
    logLevel: 'info',
  });
  if (result.errors.length > 0) {
    throw new Error(`esbuild reported ${result.errors.length} error(s).`);
  }

  // ── 4. SEA config + preparation blob ──
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: 'workjournal.bundle.cjs',
        output: 'workjournal.blob',
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: {},
      },
      null,
      2,
    ),
  );
  log('node --experimental-sea-config → workjournal.blob …');
  sh('node --experimental-sea-config sea-config.json', distBin);
  if (!existsSync(blobPath)) {
    throw new Error(`SEA blob was not produced at ${blobPath}.`);
  }

  // ── 5. Copy the Node runtime ──
  log(`copying ${process.execPath} → ${exeName} …`);
  copyFileSync(process.execPath, exePath);
  if (process.platform !== 'win32') chmodSync(exePath, 0o755);

  // ── 6a. "Refreeze": drop the runtime's own signature before injection
  //        (optional; recommended by the Node SEA docs on Windows/macOS). ──
  if (process.platform === 'win32') {
    if (commandExists('signtool')) {
      log('signtool found — removing the existing signature …');
      try {
        sh(`signtool remove /s "${exeName}"`, distBin);
      } catch (err) {
        log(`warning: signature removal failed (continuing): ${String(err)}`);
      }
    } else {
      log('signtool not found — skipping optional signature removal.');
    }
  } else if (process.platform === 'darwin' && commandExists('codesign')) {
    try {
      sh(`codesign --remove-signature "${exeName}"`, distBin);
    } catch (err) {
      log(`warning: codesign --remove-signature failed (continuing): ${String(err)}`);
    }
  }

  // ── 6b. Inject the blob ──
  const macho = process.platform === 'darwin' ? ' --macho-segment-name NODE_SEA' : '';
  log('postject: injecting NODE_SEA_BLOB …');
  sh(
    `pnpm exec postject "dist-bin/${exeName}" NODE_SEA_BLOB "dist-bin/workjournal.blob"` +
      ` --sentinel-fuse ${SENTINEL_FUSE}${macho}`,
    backendRoot,
  );

  // ── 6c. "Refreeze": re-sign after injection (optional per platform docs). ──
  if (process.platform === 'win32') {
    if (commandExists('signtool')) {
      log(
        'signtool found but no code-signing certificate is configured — leaving the executable ' +
          'unsigned (re-signing is optional on Windows; signtool can do it manually).',
      );
    } else {
      log('re-sign skipped (signtool not installed — optional on Windows).');
    }
  } else if (process.platform === 'darwin') {
    log('codesign --sign - (ad-hoc re-sign) …');
    sh(`codesign --sign - "${exeName}"`, distBin);
  }

  const sizeMb = (statSync(exePath).size / (1024 * 1024)).toFixed(1);
  log(`done: ${exePath} (${sizeMb} MB)`);
  log(`verify with: "${exePath}" --version   then: pnpm smoke:exe`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[build-exe] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
