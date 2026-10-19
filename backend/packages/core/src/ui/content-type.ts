/**
 * Content-type lookup for served dashboard assets.
 *
 * Deliberately isolated from the rest of the ui module: the codegen script
 * (`scripts/embed-ui.ts`) imports this at runtime, so it must have no import
 * path back to the generated embedded-assets module (bootstrap: that file does
 * not exist before the first codegen run).
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

/** MIME type for a file path (by extension), falling back to a safe binary type. */
export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}
