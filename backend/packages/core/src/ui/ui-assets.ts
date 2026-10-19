import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { contentTypeFor } from './content-type.js';
import { embeddedUiFiles } from './embedded-ui.generated.js';

/**
 * An in-memory dashboard asset set, decoupled from how it was produced.
 *
 * Two producers feed this shape:
 *  - `loadUiAssetsFromDir` reads a Vite `dist/` folder from disk (dev runs,
 *    `--ui-dir` overrides).
 *  - the build-time codegen (`backend/scripts/embed-ui.ts`) emits
 *    `embedded-ui.generated.ts`, so a single SEA executable can serve the
 *    dashboard with no files on disk.
 *
 * Keys are POSIX-style relative paths without a leading slash
 * ("index.html", "assets/index-D9BBea9b.js"). Content is base64 so the same
 * shape works for text and binary assets and survives TS source embedding.
 */
export interface UiAsset {
  contentType: string;
  base64: string;
}

export interface UiAssets {
  files: Record<string, UiAsset>;
  /** Decoded `index.html`; the `/` route and SPA fallback serve this. */
  indexHtml: string;
}

/** Build UiAssets from a flat path→asset map (used by embedded assets). */
export function uiAssetsFromFiles(files: Record<string, UiAsset>): UiAssets {
  const index = files['index.html'];
  if (!index) {
    throw new Error('UI asset set has no index.html — cannot serve the dashboard.');
  }
  return { files, indexHtml: Buffer.from(index.base64, 'base64').toString('utf8') };
}

/**
 * Recursively read a built dashboard directory into UiAssets.
 * Throws an actionable error when `index.html` is missing (wrong folder).
 */
export function loadUiAssetsFromDir(dir: string): UiAssets {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `Dashboard directory not found: ${dir}. Build the frontend first (pnpm build in frontend/) ` +
        `or pass --ui-dir pointing at a built dashboard (a folder containing index.html).`,
    );
  }

  const files: Record<string, UiAsset> = {};
  const collect = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        collect(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join('/');
      files[rel] = {
        contentType: contentTypeFor(rel),
        base64: readFileSync(full).toString('base64'),
      };
    }
  };
  collect(dir);

  if (!files['index.html']) {
    throw new Error(
      `No index.html in ${dir}. Pass --ui-dir pointing at the Vite build output (frontend/dist), ` +
        `not at the frontend source folder.`,
    );
  }
  return uiAssetsFromFiles(files);
}

/**
 * Dashboard assets compiled into this build by `backend/scripts/embed-ui.ts`,
 * or null when the codegen produced an empty set (frontend not built at embed
 * time). API-only startup must stay unaffected in that case.
 */
export function embeddedUiAssets(): UiAssets | null {
  if (!embeddedUiFiles || !embeddedUiFiles['index.html']) return null;
  return uiAssetsFromFiles(embeddedUiFiles);
}
