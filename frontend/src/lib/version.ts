/** App version, sourced from env with a hardcoded fallback. */
export const WORKJOURNAL_VERSION = import.meta.env.VITE_WORKJOURNAL_VERSION ?? '0.1';

/** Render the version with a "v" prefix, e.g. `v0.1`. */
export function renderVersion(): string {
  return `v${WORKJOURNAL_VERSION}`;
}
