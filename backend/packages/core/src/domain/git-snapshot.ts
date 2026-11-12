import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InternalError } from '@workjournal/shared';

/**
 * Working-tree snapshots (Addendum A).
 *
 * All git invocations use `execFileSync` with an argument array — never a shell
 * command string. A temporary index file is pointed at via `GIT_INDEX_FILE`, so
 * the user's real index, branch, HEAD, stash and `git status` are never touched.
 *
 * Capture procedure (per A2):
 *   1. Temp index file + GIT_INDEX_FILE
 *   2. `git read-tree HEAD` (seed from HEAD; skipped when the repo has no commits)
 *   3. `git add -A` (stage whole working tree, respecting .gitignore + excludes)
 *   4. `git write-tree` → tree sha; `git commit-tree tree [-p HEAD]` → commit sha
 *   5. `git update-ref refs/workjournal/<task-id>/<seq>` → store commit under private ref
 *   6. Delete temp index
 */

export const WORKJOURNAL_REF_PREFIX = 'refs/workjournal';
export const DEFAULT_EXCLUDE_PATTERNS = ['.workjournal/', 'node_modules/'];

export type GitRepoInfo = {
  isRepo: boolean;
  root: string | null;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  hasCommits: boolean;
};

export type SnapshotCaptureResult = {
  commitSha: string;
  treeSha: string;
  parentSha: string | null;
  refName: string;
  baseHeadSha: string | null;
  branchName: string | null;
  detachedHead: boolean;
  hasCommits: boolean;
};

/** Ref name per A3: refs/workjournal/<task-id>/<seq>. */
export function snapshotRefName(taskId: string, sequence: number): string {
  return `${WORKJOURNAL_REF_PREFIX}/${encodeRefSegment(taskId)}/${sequence}`;
}

/** task-id may contain chars unsafe in a ref segment; hash it to keep refs valid. */
function encodeRefSegment(taskId: string): string {
  return 'wj-' + createHash('sha1').update(taskId).digest('hex').slice(0, 12);
}

/** Run git with an argument array. Never builds a shell command string. */
function execGit(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env, ...(opts.env ?? {}) };
  let result: ReturnType<typeof execFileSync>;
  try {
    result = execFileSync('git', args, {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024, // 50 MB cap for large diffs
      shell: undefined, // force direct exec, no shell
    });
    return { code: 0, stdout: String(result), stderr: '' };
  } catch (err: any) {
    return {
      code: err?.status ?? 1,
      stdout: typeof err?.stdout === 'string' ? err.stdout : '',
      stderr: typeof err?.stderr === 'string' ? err.stderr : String(err?.message ?? err),
    };
  }
}

/** Inspect the repository state at `cwd` (project root). Never mutates anything. */
export function inspectRepo(cwd: string): GitRepoInfo {
  const head = execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  const hasCommits = head.code === 0 && head.stdout.trim().length > 0;
  const headSha = hasCommits ? head.stdout.trim() : null;

  const toplevel = execGit(['rev-parse', '--show-toplevel'], { cwd });
  const isRepo = toplevel.code === 0;
  const root = isRepo ? toplevel.stdout.trim() : null;

  let branch: string | null = null;
  let detached = false;
  if (hasCommits) {
    const symbolic = execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (symbolic.code === 0 && symbolic.stdout.trim().length > 0) {
      branch = symbolic.stdout.trim();
    } else {
      detached = true;
      // short HEAD for detached indication
      branch = headSha ? headSha.slice(0, 12) : null;
    }
  }

  return { isRepo, root, headSha, branch, detached, hasCommits };
}

/**
 * Capture the full working tree into a private ref and return the commit/sha.
 * Returns a degraded result (with `degraded` and `reason`) when the repo is
 * unavailable — the caller decides whether to fail or continue (A3).
 */
export function captureWorkingTree(
  rootPath: string,
  taskId: string,
  sequence: number,
  actor: string,
  opts?: {
    excludePatterns?: string[];
    /** Max total bytes of file content to include in the snapshot summary. */
    maxTotalBytes?: number;
    /** Max bytes per file included in the snapshot summary. */
    maxFileBytes?: number;
  },
): {
  degraded: boolean;
  reason: string | null;
  result: SnapshotCaptureResult | null;
  excludedPaths: string[];
} {
  const excludePatterns = opts?.excludePatterns ?? [...DEFAULT_EXCLUDE_PATTERNS];
  const maxTotalBytes = opts?.maxTotalBytes ?? 5_000_000;
  const maxFileBytes = opts?.maxFileBytes ?? 1_000_000;

  const repo = inspectRepo(rootPath);
  if (!repo.isRepo || !repo.root) {
    return {
      degraded: true,
      reason: 'not a git repository',
      result: null,
      excludedPaths: [],
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'workjournal-snap-'));
  const tempIndex = join(tempDir, 'index');
  try {
    const env = { GIT_INDEX_FILE: tempIndex };

    // 2. Seed from HEAD (skip when there are no commits yet — orphan repo).
    if (repo.hasCommits) {
      const seed = execGit(['read-tree', 'HEAD'], { cwd: repo.root, env });
      if (seed.code !== 0) {
        return {
          degraded: true,
          reason: `git read-tree failed: ${seed.stderr.trim() || seed.stdout.trim()}`,
          result: null,
          excludedPaths: [],
        };
      }
    }

    // 3. Stage the whole working tree into the temp index (respects .gitignore).
    const add = execGit(['add', '-A'], { cwd: repo.root, env });
    if (add.code !== 0) {
      return {
        degraded: true,
        reason: `git add -A failed: ${add.stderr.trim() || add.stdout.trim()}`,
        result: null,
        excludedPaths: [],
      };
    }

    // Apply the exclude list: unstage anything matching configured patterns so
    // .workjournal/, node_modules, etc. never end up in the snapshot commit.
    // A trailing `/` means "this directory and everything beneath it".
    const isDirPattern = (pattern: string) => pattern.endsWith('/');
    const dirOf = (pattern: string) => pattern.slice(0, -1);
    const globToRegex = (pattern: string): RegExp => {
      const body = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      if (isDirPattern(pattern)) {
        // Match the directory itself or anything beneath it.
        return new RegExp(`^(?:${body})$|^${body}/`);
      }
      return new RegExp(`^${body}$`);
    };

    const excludedPaths: string[] = [];
    for (const pattern of excludePatterns) {
      // Unstage any indexed path beneath an excluded directory.
      const rmTarget = isDirPattern(pattern) ? dirOf(pattern) : pattern;
      const rm = execGit(['rm', '--cached', '--ignore-unmatch', '-r', '--', rmTarget], {
        cwd: repo.root,
        env,
      });
      // (ignore-unmatch means a non-zero exit when nothing matched is fine)
    }

    // Determine which working-tree paths ended up excluded from the snapshot.
    const lsAll = execGit(['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: repo.root,
      env,
    });
    const allPaths = lsAll.stdout.split('\n').filter(Boolean);
    const regexes = excludePatterns.map(globToRegex);
    for (const p of allPaths) {
      if (regexes.some((re) => re.test(p))) excludedPaths.push(p);
    }

    // 4. write-tree then commit-tree.
    const writeTree = execGit(['write-tree'], { cwd: repo.root, env });
    if (writeTree.code !== 0) {
      return {
        degraded: true,
        reason: `git write-tree failed: ${writeTree.stderr.trim() || writeTree.stdout.trim()}`,
        result: null,
        excludedPaths,
      };
    }
    const treeSha = writeTree.stdout.trim();

    const parentArgs = repo.hasCommits ? ['-p', repo.headSha!] : [];
    const commitTree = execGit(
      [
        'commit-tree',
        treeSha,
        ...parentArgs,
        '-m',
        `workjournal snapshot task=${taskId} seq=${sequence} actor=${actor}`,
      ],
      { cwd: repo.root, env },
    );
    if (commitTree.code !== 0) {
      return {
        degraded: true,
        reason: `git commit-tree failed: ${commitTree.stderr.trim() || commitTree.stdout.trim()}`,
        result: null,
        excludedPaths,
      };
    }
    const commitSha = commitTree.stdout.trim();

    // 5. Store under the private ref.
    const refName = snapshotRefName(taskId, sequence);
    const updateRef = execGit(['update-ref', refName, commitSha], { cwd: repo.root, env });
    if (updateRef.code !== 0) {
      return {
        degraded: true,
        reason: `git update-ref failed: ${updateRef.stderr.trim() || updateRef.stdout.trim()}`,
        result: null,
        excludedPaths,
      };
    }

    return {
      degraded: false,
      reason: null,
      result: {
        commitSha,
        treeSha,
        parentSha: repo.hasCommits ? repo.headSha : null,
        refName,
        baseHeadSha: repo.headSha,
        branchName: repo.branch,
        detachedHead: repo.detached,
        hasCommits: repo.hasCommits,
      },
      excludedPaths: [...new Set(excludedPaths)],
    };
  } finally {
    // 5. Delete the temporary index file.
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Diff summary between two refs (commit SHAs) of the same repo: changed paths
 * with status, insertions and deletions. Binary files tracked as status 'binary'.
 */
export function diffRefs(
  rootPath: string,
  refA: string,
  refB: string,
): {
  changedFiles: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean; previousPath?: string }>;
  insertions: number;
  deletions: number;
} {
  const repo = inspectRepo(rootPath);
  if (!repo.isRepo || !repo.root) {
    return { changedFiles: [], insertions: 0, deletions: 0 };
  }

  // Name-status with rename detection.
  const ns = execGit(['diff', '--find-renames', '--name-status', refA, refB], {
    cwd: repo.root,
  });
  const entries = parseDiffNameStatus(ns.stdout);

  // Numstat for insertions/deletions (binary files show "-\t-").
  const num = execGit(['diff', '--find-renames', '--numstat', refA, refB], { cwd: repo.root });
  const counts = parseDiffNumstat(num.stdout);

  let insertions = 0;
  let deletions = 0;
  const changedFiles: typeof entries = [];
  for (const e of entries) {
    const c = counts.find((x) => x.path === e.path);
    const ins = c?.insertions ?? 0;
    const dels = c?.deletions ?? 0;
    const binary = c?.binary ?? e.status === 'binary';
    insertions += ins;
    deletions += dels;
    changedFiles.push({ ...e, insertions: ins, deletions: dels, binary });
  }
  return { changedFiles: changedFiles.sort((a, b) => a.path.localeCompare(b.path)), insertions, deletions };
}

/** Diff latest snapshot against the current working tree (drift, live). */
export function diffWorktreeVsRef(
  rootPath: string,
  ref: string,
): { changedFiles: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean }>; insertions: number; deletions: number } {
  const repo = inspectRepo(rootPath);
  if (!repo.isRepo || !repo.root) {
    return { changedFiles: [], insertions: 0, deletions: 0 };
  }
  const ns = execGit(['diff', '--name-status', ref, '--'], { cwd: repo.root });
  const entries = parseDiffNameStatus(ns.stdout);
  const num = execGit(['diff', '--numstat', ref, '--'], { cwd: repo.root });
  const counts = parseDiffNumstat(num.stdout);
  let insertions = 0;
  let deletions = 0;
  const out: typeof entries = [];
  for (const e of entries) {
    const c = counts.find((x) => x.path === e.path);
    const ins = c?.insertions ?? 0;
    const dels = c?.deletions ?? 0;
    insertions += ins;
    deletions += dels;
    out.push({ ...e, insertions: ins, deletions: dels, binary: c?.binary ?? false });
  }
  return { changedFiles: out.sort((a, b) => a.path.localeCompare(b.path)), insertions, deletions };
}

/** Diff a ref against current HEAD (what has since been committed). */
export function diffRefVsHead(
  rootPath: string,
  ref: string,
): { changedFiles: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean }>; insertions: number; deletions: number } {
  const repo = inspectRepo(rootPath);
  if (!repo.isRepo || !repo.hasCommits) {
    return { changedFiles: [], insertions: 0, deletions: 0 };
  }
  return diffRefs(rootPath, ref, 'HEAD');
}

/** Full patch between two refs, capped by maxBytes. */
export function patchRefs(
  rootPath: string,
  refA: string,
  refB: string,
  maxBytes: number,
): { patch: string; truncated: boolean } {
  const repo = inspectRepo(rootPath);
  if (!repo.isRepo || !repo.root) {
    return { patch: '', truncated: false };
  }
  const res = execGit(['diff', '--binary', '--find-renames', refA, refB], { cwd: repo.root });
  const text = res.stdout;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { patch: text, truncated: false };
  }
  // Truncate at a line boundary near the cap.
  let bytes = 0;
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    bytes += Buffer.byteLength(text[i], 'utf8');
    if (bytes > maxBytes) {
      cut = i;
      break;
    }
  }
  return { patch: text.slice(0, cut).replace(/\n+$/, '\n') + '\n... [patch truncated] ...\n', truncated: true };
}

/** Heuristic binary detection: a file containing a NUL byte is treated as binary. */
export function isBinaryFile(rootPath: string, path: string): boolean {
  try {
    const buf = readFileSync(join(rootPath, path));
    return buf.indexOf(0) !== -1;
  } catch {
    return false;
  }
}

/* ---------- rollback engine helpers (Addendum B) ---------- */

/**
 * Commit-to-commit path set for the rollback plan: A/D/M entries with rename
 * detection off, so a rename is naturally an add + delete pair that apply
 * handles as write + delete. Throws when the diff fails (bad sha, not a repo).
 */
export function diffPathSet(
  rootPath: string,
  targetSha: string,
  effectiveSha: string,
): Array<{ path: string; inTarget: boolean; inEffective: boolean }> {
  const repo = inspectRepo(rootPath);
  if (!repo.isRepo || !repo.root) {
    throw new Error(`revert is unavailable: ${rootPath} is not a git repository`);
  }
  const res = execGit(['diff', '--name-status', '--no-renames', targetSha, effectiveSha], {
    cwd: repo.root,
  });
  if (res.code !== 0) {
    throw new Error(`git diff failed: ${res.stderr.trim() || 'unknown error'}`);
  }
  const out: Array<{ path: string; inTarget: boolean; inEffective: boolean }> = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const letter = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if (letter === 'A') out.push({ path, inTarget: false, inEffective: true });
    else if (letter === 'D') out.push({ path, inTarget: true, inEffective: false });
    else out.push({ path, inTarget: true, inEffective: true }); // M, T, U…
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Mode + object id of one path in a commit (`git ls-tree`), or null when absent. */
export function lsTreeEntry(
  rootPath: string,
  commitSha: string,
  path: string,
): { mode: string; oid: string } | null {
  const res = execGit(['ls-tree', commitSha, '--', path], { cwd: rootPath });
  if (res.code !== 0) return null;
  const line = res.stdout.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  // Format: "<mode> <type> <oid>\t<path>"
  const tab = line.indexOf('\t');
  const meta = (tab === -1 ? line : line.slice(0, tab)).split(' ');
  if (meta.length < 3) return null;
  return { mode: meta[0], oid: meta[2] };
}

/** Blob bytes for a path at a commit; null when absent or unaddressable. */
export function blobAt(rootPath: string, commitSha: string, path: string): Buffer | null {
  try {
    const buf = execFileSync('git', ['cat-file', 'blob', `${commitSha}:${path}`], {
      cwd: rootPath,
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
      shell: undefined,
    });
    return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  } catch {
    return null;
  }
}

/** Tree sha of a commit — two snapshots with equal trees are a rollback no-op. */
export function treeSha(rootPath: string, commitSha: string): string | null {
  const res = execGit(['rev-parse', '--verify', '--quiet', `${commitSha}^{tree}`], {
    cwd: rootPath,
  });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/* ---------- parsing helpers ---------- */

type DiffEntry = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  previousPath?: string;
};

function parseDiffNameStatus(output: string): DiffEntry[] {
  const out: DiffEntry[] = [];
  const records = output.split('\n').filter(Boolean);
  for (const rec of records) {
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const status = rec.slice(0, tab);
    const rest = rec.slice(tab + 1);
    if (status.startsWith('R') || status.startsWith('C')) {
      const secondTab = rest.indexOf('\t');
      if (secondTab !== -1) {
        out.push({ path: rest.slice(secondTab + 1), status: 'renamed', insertions: 0, deletions: 0, binary: false, previousPath: rest.slice(0, secondTab) });
      } else {
        out.push({ path: rest, status: 'modified', insertions: 0, deletions: 0, binary: false });
      }
    } else if (status === 'D') {
      out.push({ path: rest, status: 'deleted', insertions: 0, deletions: 0, binary: false });
    } else if (status === 'A') {
      out.push({ path: rest, status: 'added', insertions: 0, deletions: 0, binary: false });
    } else if (status === 'M') {
      out.push({ path: rest, status: 'modified', insertions: 0, deletions: 0, binary: false });
    } else if (status === 'B') {
      out.push({ path: rest, status: 'binary', insertions: 0, deletions: 0, binary: true });
    } else {
      out.push({ path: rest, status: 'modified', insertions: 0, deletions: 0, binary: false });
    }
  }
  return out;
}

interface NumStatEntry { path: string; insertions: number; deletions: number; binary: boolean; }

function parseDiffNumstat(output: string): NumStatEntry[] {
  const out: NumStatEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const insRaw = parts[0];
    const delsRaw = parts[1];
    const path = parts.slice(2).join('\t');
    const binary = insRaw === '-' && delsRaw === '-';
    out.push({
      path,
      insertions: binary ? 0 : parseInt(insRaw, 10) || 0,
      deletions: binary ? 0 : parseInt(delsRaw, 10) || 0,
      binary,
    });
  }
  return out;
}
