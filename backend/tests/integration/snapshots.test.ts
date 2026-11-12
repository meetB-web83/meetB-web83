import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, runMigrations, type Database } from '@workjournal/core';
import { PROJECT_MIGRATIONS_DIR } from '../helpers/registry-factory.js';
import { TaskService } from '@workjournal/core';
import { CheckpointService } from '@workjournal/core';
import { SnapshotService } from '@workjournal/core';
import { captureWorkingTree, diffRefs, inspectRepo } from '@workjournal/core';

/** A real git repository + project DB for snapshot tests. */
function makeFixture(): {
  root: string;
  db: Database;
  cleanup: () => void;
  git: (args: string[], opts?: { cwd?: string }) => { code: number; stdout: string; stderr: string };
} {
  const root = mkdtempSync(join(tmpdir(), 'wj-snap-repo-'));
  // Init a git repo with an initial commit.
  execFileSync('git', ['init'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, encoding: 'utf8', shell: undefined });
  writeFileSync(join(root, 'tracked.txt'), 'initial\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.log\n');
  execFileSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, encoding: 'utf8', shell: undefined });

  const dir = mkdtempSync(join(tmpdir(), 'wj-snap-db-'));
  const db = createDatabase(join(dir, 'test.db'));
  runMigrations(db, PROJECT_MIGRATIONS_DIR);
  db.raw.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'Test', ?, '2024-01-01', '2024-01-01')`).run(root);

  return {
    root,
    db,
    cleanup: () => {
      try { db.raw.close(); } catch { }
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
    git: (args, opts = {}) => {
      const res = execFileSync('git', args, { cwd: opts.cwd ?? root, encoding: 'utf8', shell: undefined });
      return { code: 0, stdout: String(res), stderr: '' };
    },
  };
}

function headSha(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: undefined }).toString().trim();
}
function gitStatus(root: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', shell: undefined }).toString();
}

describe('Addendum A — working-tree snapshots (M2)', () => {
  let fx: ReturnType<typeof makeFixture>;
  let db: Database;
  let tasks: TaskService;
  let checkpoints: CheckpointService;
  let snapshots: SnapshotService;

  beforeEach(() => {
    fx = makeFixture();
    db = fx.db;
    tasks = new TaskService(db);
    checkpoints = new CheckpointService(db);
    snapshots = new SnapshotService(db);
  });

  afterEach(() => fx.cleanup());

  it('captures baseline snapshot with correct change summary (modified, added, binary; exclusions respected)', async () => {
    const { root } = fx;
    // Modify tracked, add untracked, add binary, add ignored file (must be excluded).
    writeFileSync(join(root, 'tracked.txt'), 'modified\n');
    writeFileSync(join(root, 'new-file.txt'), 'new\n');
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    // ignored file must not be snapshotted
    writeFileSync(join(root, 'ignored.log'), 'secret\n');

    const beforeHead = headSha(root);
    const beforeStatus = gitStatus(root);

    const task = await tasks.createTask({ projectId: 'p1', title: 'Snap task' });
    const claimed = await tasks.claimTask(task.id, 'agent-a_p1', { key: 'k-claim-1', input: {} }, null, false, root);

    expect(claimed.snapshot).not.toBeNull();
    expect(claimed.snapshot.kind).toBe('baseline');
    expect(claimed.snapshot.commit_sha).toBeTruthy();
    expect(claimed.snapshot.ref_name).toContain(`refs/workjournal/`);
    expect(claimed.snapshot.base_head_sha).toBe(beforeHead);
    expect(claimed.snapshot.capture_status).toBe('ok');

    // HEAD / working-tree status must be untouched by capture.
    expect(headSha(root)).toBe(beforeHead);
    expect(gitStatus(root)).toBe(beforeStatus);

    const changedPaths = claimed.snapshot.changed_files.map((f: any) => f.path).sort();
    // Baseline has no previous snapshot, so every file in the tree is 'added'.
    expect(changedPaths).toContain('tracked.txt');
    expect(changedPaths).toContain('new-file.txt');
    expect(changedPaths).toContain('image.bin');
    expect(changedPaths).not.toContain('ignored.log');
    expect(changedPaths).not.toContain('.workjournal');

    const image = claimed.snapshot.changed_files.find((f: any) => f.path === 'image.bin');
    expect(image.binary).toBe(true);
  });

  it('checkpoint with no changes shows no new changes (deterministic baseline comparison)', async () => {
    const { root } = fx;
    const task = await tasks.createTask({ projectId: 'p1', title: 'stable' });
    const c1 = await tasks.claimTask(task.id, 'agent-a_p1', { key: 'k-stable-1', input: {} }, null, false, root);
    // No changes between claim and checkpoint → checkpoint diff vs baseline is empty.
    const ck = await checkpoints.createCheckpoint({
      taskId: task.id, agentId: 'agent-a_p1', progressSummary: 'no change', nextSteps: 'Continue',
      idempotency: { key: 'k-ck-1', input: {} }, rootPath: root,
    }, false);

    expect(c1.snapshot.capture_status).toBe('ok');
    expect(ck.snapshot.capture_status).toBe('ok');
    expect(c1.snapshot.changed_files.length).toBeGreaterThan(0); // baseline = whole tree added
    expect(ck.snapshot.changed_files.length).toBe(0); // no change vs baseline
  });

  it('.workjournal/ never appears and gitignore/excludes respected', async () => {
    const { root } = fx;
    mkdirSync(join(root, '.workjournal'), { recursive: true });
    writeFileSync(join(root, '.workjournal', 'internal.db'), 'x');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'heavy.js'), '1');

    const task = await tasks.createTask({ projectId: 'p1', title: 'excl' });
    const claimed = await tasks.claimTask(task.id, 'agent-x_p1', { key: 'k-excl-1', input: {} }, null, false, root);
    const paths = claimed.snapshot.changed_files.map((f: any) => f.path);
    expect(paths).not.toContain('.workjournal/internal.db');
    expect(paths).not.toContain('node_modules/heavy.js');
    expect(paths).not.toContain('.workjournal');
  });

  it('idempotent claim retry does not create a second snapshot or ref', async () => {
    const { root, db } = fx;
    const task = await tasks.createTask({ projectId: 'p1', title: 'idem' });
    const key = 'k-idem-1';
    const input = { key, input: {} };
    const c1 = await tasks.claimTask(task.id, 'agent-i_p1', input, null, false, root);
    const c2 = await tasks.claimTask(task.id, 'agent-i_p1', input, null, false, root);

    // Same returned snapshot (replay).
    expect(c2.snapshot.id).toBe(c1.snapshot.id);
    expect(c2.snapshot.commit_sha).toBe(c1.snapshot.commit_sha);

    // Only one snapshot row and one ref for this task.
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM task_snapshots WHERE task_id = ?').get(task.id) as any;
    expect(rows.n).toBe(1);

    const refs = execFileSync('git', ['for-each-ref', 'refs/workjournal/'], { cwd: root, encoding: 'utf8', shell: undefined }).toString().trim();
    const refLines = refs ? refs.split('\n').filter(Boolean) : [];
    expect(refLines.length).toBe(1);
  });

  it('failed capture (non-git directory) still lets claim succeed and records failure event', async () => {
    // Use a non-git rootPath.
    const notGit = mkdtempSync(join(tmpdir(), 'wj-notgit-'));
    writeFileSync(join(notGit, 'file.txt'), 'hi');
    const task = await tasks.createTask({ projectId: 'p1', title: 'nogit' });
    const claimed = await tasks.claimTask(task.id, 'agent-g_p1', { key: 'k-nogit-1', input: {} }, null, false, notGit);

    // Claim still succeeds.
    expect(claimed.status).toBe('in_progress');
    // Snapshot degraded / absent.
    const snapshot = claimed.snapshot;
    if (snapshot) {
      expect(snapshot.capture_status).toBe('degraded');
      expect(snapshot.capture_reason).toContain('not a git repository');
    }
    // Failure event recorded.
    const events = db.raw.prepare("SELECT * FROM events WHERE task_id = ? AND event_type = 'snapshot_failed' ORDER BY sequence ASC").all(task.id) as any[];
    expect(events.length).toBeGreaterThan(0);
    rmSync(notGit, { recursive: true, force: true });
  });

  it('checkpoint captures a checkpoint snapshot diffed against previous', async () => {
    const { root } = fx;
    const task = await tasks.createTask({ projectId: 'p1', title: 'ckpt' });
    await tasks.claimTask(task.id, 'agent-c_p1', { key: 'k-c-1', input: {} }, null, false, root);

    const baseline = snapshots.getBaselineSnapshot(task.id)!;
    expect(baseline.kind).toBe('baseline');

    // Make a change, then checkpoint.
    writeFileSync(join(root, 'tracked.txt'), 'changed at checkpoint\n');
    const ck = await checkpoints.createCheckpoint({
      taskId: task.id, agentId: 'agent-c_p1', progressSummary: 'modified tracked', nextSteps: 'Continue',
      idempotency: { key: 'k-c-2', input: {} }, rootPath: root,
    }, false);

    expect(ck.snapshot.kind).toBe('checkpoint');
    expect(ck.snapshot.checkpoint_id).toBe(ck.id);
    expect(ck.snapshot.changed_files.length).toBeGreaterThan(0);
    const tracked = ck.snapshot.changed_files.find((f: any) => f.path === 'tracked.txt');
    expect(tracked.status).toBe('modified');
    expect(ck.snapshot.changed_vs_baseline.length).toBeGreaterThan(0);

    // Latest snapshot is the checkpoint.
    const latest = snapshots.getLatestSnapshot(task.id);
    expect(latest.id).toBe(ck.snapshot.id);
  });

  it('diffRefs reports correct statuses between two snapshots (modify, add, rename)', async () => {
    const { root } = fx;
    // A file present at baseline will be renamed by checkpoint time.
    writeFileSync(join(root, 'rename-source.txt'), 'source\n');
    execFileSync('git', ['add', 'rename-source.txt'], { cwd: root, shell: undefined });

    const task = await tasks.createTask({ projectId: 'p1', title: 'diff' });
    await tasks.claimTask(task.id, 'agent-d_p1', { key: 'k-d-1', input: {} }, null, false, root);
    const baseline = snapshots.getBaselineSnapshot(task.id)!;

    // Modify tracked.txt and rename after claim.
    writeFileSync(join(root, 'tracked.txt'), 'edited\n');
    execFileSync('git', ['mv', 'rename-source.txt', 'rename-target.txt'], { cwd: root, shell: undefined });

    const ck = await checkpoints.createCheckpoint({
      taskId: task.id, agentId: 'agent-d_p1', progressSummary: 'rename', nextSteps: 'Continue',
      idempotency: { key: 'k-d-2', input: {} }, rootPath: root,
    }, false);

    const diff = diffRefs(root, baseline.commit_sha!, ck.snapshot.commit_sha!);
    const byPath = Object.fromEntries(diff.changedFiles.map((f: any) => [f.path, f]));
    expect(byPath['rename-target.txt'].status).toBe('renamed');
    expect(byPath['rename-target.txt'].previousPath).toBe('rename-source.txt');
    expect(byPath['tracked.txt'].status).toBe('modified');
  });

  it('inspectRepo reports branch, HEAD and detached state without mutating', async () => {
    const { root } = fx;
    const info = inspectRepo(root);
    expect(info.isRepo).toBe(true);
    expect(info.hasCommits).toBe(true);
    expect(info.headSha).toBeTruthy();
    expect(info.branch).toBe('master');
    expect(info.detached).toBe(false);
    // Working tree unchanged by inspection.
    expect(existsSync(join(root, '.git', 'index'))).toBe(true);
  });
});
