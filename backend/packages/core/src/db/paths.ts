import { statSync, accessSync, constants } from 'node:fs';
import { posix } from 'node:path';
import { ValidationError } from '@workjournal/shared';

/**
 * Container mount point for the host's project directory (PROJECTS_DIRECTORY).
 *
 * The core service is the only component that touches project folders; the MCP
 * adapter and the dashboard talk to it over HTTP, so host paths never need to
 * reach them. When PROJECTS_DIRECTORY is configured, every filesystem
 * operation inside the container uses `/host-projects/...` while the host
 * side keeps the original path (e.g. `C:/Users/you/code`) for display.
 */
export const CONTAINER_PROJECTS_ROOT = '/host-projects';

export interface PathContext {
  /** Host-side projects directory (PROJECTS_DIRECTORY). Mapping/display only. */
  hostRoot: string;
  /** In-container mount point used for all filesystem operations. */
  containerRoot: string;
}

/**
 * Normalise separators and trailing slashes for comparison. Pure string
 * operation — no OS calls, safe to unit test without Docker.
 */
export function normalizeProjectPath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Build the path context from the environment.
 *
 * PROJECTS_DIRECTORY unset → null: native development. Every path is used as
 * given — no mapping, no containment rules (legacy behaviour preserved).
 *
 * PROJECTS_DIRECTORY set → { hostRoot, containerRoot: '/host-projects' }. The
 * host path is a mapping key only; it is never touched on the container
 * filesystem (a Windows path does not exist inside Linux).
 */
export function loadPathContext(env: NodeJS.ProcessEnv = process.env): PathContext | null {
  const hostRoot = normalizeProjectPath(env.PROJECTS_DIRECTORY || '');
  if (!hostRoot) return null;
  return { hostRoot, containerRoot: CONTAINER_PROJECTS_ROOT };
}

/** True when `candidate` is `root` itself or inside it (both pre-normalised). */
export function isWithinRoot(root: string, candidate: string): boolean {
  const r = normalizeProjectPath(root);
  const c = normalizeProjectPath(candidate);
  if (r === c) return true;
  // Compare segment-by-segment so `/host-projects-evil` never matches
  // `/host-projects`.
  return c.startsWith(`${r}/`);
}

/**
 * Map a user-supplied path to the container path used for filesystem access.
 *
 * - Already a container path → returned as-is.
 * - A host path under the configured host root → mapped to
 *   `/host-projects/<relative>`.
 * - Anything else → ValidationError (outside the configured root). Never falls
 *   back to an unrelated directory inside the container.
 *
 * With no path context (native dev), the input is returned unchanged.
 */
export function toContainerPath(ctx: PathContext | null, input: string): string {
  if (!ctx) return input;
  const clean = normalizeProjectPath(input);
  if (!clean) {
    throw new ValidationError('Project path must not be empty.');
  }
  // Collapse `..` segments BEFORE any containment check so
  // `/host-projects/../etc` can never pass as "inside".
  const collapsed = posix.normalize(clean);
  if (isWithinRoot(ctx.containerRoot, collapsed)) return collapsed;

  if (isWithinRoot(ctx.hostRoot, collapsed)) {
    const relative = collapsed.slice(normalizeProjectPath(ctx.hostRoot).length).replace(/^\/+/, '');
    const mapped = posix.normalize(`${ctx.containerRoot}/${relative}`);
    if (isWithinRoot(ctx.containerRoot, mapped)) return mapped;
  }

  throw new ValidationError(
    `Project path "${input}" is outside the configured projects directory ` +
      `(${ctx.hostRoot} → ${ctx.containerRoot}/). Register a folder inside ${ctx.hostRoot}.`,
  );
}

/** Reverse mapping for display: `/host-projects/X` → host path. Pass-through otherwise. */
export function fromContainerPath(ctx: PathContext | null, containerPath: string): string {
  if (!ctx) return containerPath;
  const clean = normalizeProjectPath(containerPath);
  if (isWithinRoot(ctx.containerRoot, clean)) {
    const relative = clean.slice(ctx.containerRoot.length).replace(/^\/+/, '');
    if (!relative) return ctx.hostRoot;
    return `${ctx.hostRoot}/${relative}`;
  }
  return containerPath;
}

/**
 * Startup validation for the container projects mount.
 *
 * Returns an actionable error message, or null when the configuration is fine
 * (including when PROJECTS_DIRECTORY is not set — nothing to validate).
 * Called from buildServer so every entry point (main.ts, CLI start) enforces
 * it. Tests that call buildServer without PROJECTS_DIRECTORY are unaffected.
 */
export function validateProjectsMount(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const hostRoot = normalizeProjectPath(env.PROJECTS_DIRECTORY || '');
  if (!hostRoot) return null;

  try {
    if (!statSync(CONTAINER_PROJECTS_ROOT).isDirectory()) {
      return (
        `PROJECTS_DIRECTORY is set (${hostRoot}) but ${CONTAINER_PROJECTS_ROOT} is not ` +
        `mounted as a directory. Docker: check your Compose bind mount and override files.`
      );
    }

    accessSync(CONTAINER_PROJECTS_ROOT, constants.R_OK | constants.W_OK);

    // Both checks passed. The mount is valid.
    return null;
  } catch (err: unknown) {
    const detail =
      err instanceof Error && 'code' in err
        ? String(err.code)
        : err instanceof Error
          ? err.message
          : 'unknown error';

    return (
      `PROJECTS_DIRECTORY is set (${hostRoot}) but ${CONTAINER_PROJECTS_ROOT} is not ` +
      `readable/writable inside this container (${detail}). Docker Desktop: enable the ` +
      `drive/folder under Settings → Resources → File sharing, then recreate the core ` +
      `container. Never fall back to an unrelated directory.`
    );
  }
}
