import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  runMigrations,
  type Database,
  TaskService,
  CheckpointService,
  SnapshotService,
  RollbackService,
  EventService,
  ResumeBuilder,
  JsonExporter,
  MarkdownExporter,
  getRollbackView,
  annotateRollbackFlags,
  validateRelativePath,
  assertPathInsideRoot,
  diffRefs,
} from '@workjournal/core';
import {
  OPERATOR,
  OwnerMismatchError,
  ValidationError,
  IdempotencyConflictError,
  previewRevertTaskSchema,
  revertTaskChangesSchema,
  handoffJsonSchema,
} from '@workjournal/shared';
import { PROJECT_MIGRATIONS_DIR } from '../helpers/registry-factory.js';

/**
 * Addendum A/B — unified revert/rollback engine (spec §14, B11 list 1-18).
 * Real temp git repos + real project migrations; no DB mocks.
 */

const OWNER = 'agent-a_p1';
const OTHER = 'agent-b_p1';
const REASON = 'checkpoint 3 produced broken output';

function makeFixture(): {
  root: string;
  db: Database;
  cleanup: () => void;
  git: (args: string[]) => string;
} {
  const root = mkdtempSync(join(tmpdir(), 'wj-rb-repo-'));
  execFileSync('git', ['init'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, encoding: 'utf8', shell: undefined });
  // Cross-platform determinism: git must not infer exec bits from the worktree.
  execFileSync('git', ['config', 'core.filemode', 'false'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, encoding: 'utf8', shell: undefined });
  writeFileSync(join(root, 'tracked.txt'), 'initial\n');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.log\n');
  execFileSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8', shell: undefined });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, encoding: 'utf8', shell: undefined });

  const dir = mkdtempSync(join(tmpdir(), 'wj-rb-db-'));
  const db = createDatabase(join(dir, 'test.db'));
  runMigrations(db, PROJECT_MIGRATIONS_DIR);
  db.raw
    .prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1', 'Test', ?, '2024-01-01', '2024-01-01')`)
    .run(root);

  return {
    root,
    db,
    cleanup: () => {
      try { db.raw.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
    git: (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', shell: undefined }),
  };
}

describe('Addendum A/B — working-tree snapshots + rollback engine (M6, B11)', () => {
  let fx: ReturnType<typeof makeFixture>;
  let root: string;
  let db: Database;
  let tasks: TaskService;
  let checkpoints: CheckpointService;
  let snapshots: SnapshotService;
  let rollback: RollbackService;
  let events: EventService;
  let resume: ResumeBuilder;
  let jsonExport: JsonExporter;
  let mdExport: MarkdownExporter;
  let keySeq: number;
  let nextKey: () => string;

  beforeEach(() => {
    fx = makeFixture();
    root = fx.root;
    db = fx.db;
    tasks = new TaskService(db);
    checkpoints = new CheckpointService(db);
    snapshots = new SnapshotService(db);
    rollback = new RollbackService(db);
    events = new EventService(db);
    resume = new ResumeBuilder(db);
    jsonExport = new JsonExporter(db);
    mdExport = new MarkdownExporter(db);
    keySeq = 0;
    nextKey = () => `k-rb-${++keySeq}`;
  });

  afterEach(() => fx.cleanup());

  /** Claim + checkpoints 1-2-3. Sequences: baseline=1, cp1=2, cp2=3, cp3=4. */
  async function seedThreeCheckpoints() {
    const task = await tasks.createTask({ projectId: 'p1', title: 'Rollback task' });
    const claimed = await tasks.claimTask(task.id, OWNER, { key: nextKey(), input: {} }, null, false, root);
    const baseline = claimed.snapshot;

    writeFileSync(join(root, 'tracked.txt'), 'v1\n');
    writeFileSync(join(root, 'file-a.txt'), 'a1\n');
    const cp1 = await checkpoints.createCheckpoint(
      {
        taskId: task.id, agentId: OWNER, progressSummary: 'checkpoint one',
        completedWork: 'did a', currentFindings: 'f1', unresolvedIssues: 'u1', nextSteps: 'continue',
        idempotency: { key: nextKey(), input: {} }, rootPath: root,
      },
      false,
    );

    writeFileSync(join(root, 'tracked.txt'), 'v2\n');
    writeFileSync(join(root, 'file-b.txt'), 'b2\n');
    const cp2 = await checkpoints.createCheckpoint(
      {
        taskId: task.id, agentId: OWNER, progressSummary: 'checkpoint two',
        completedWork: 'did b', currentFindings: 'f2', unresolvedIssues: 'u2', nextSteps: 'continue',
        idempotency: { key: nextKey(), input: {} }, rootPath: root,
      },
      false,
    );

    writeFileSync(join(root, 'tracked.txt'), 'v3\n');
    writeFileSync(join(root, 'file-c.txt'), 'c3\n');
    const cp3 = await checkpoints.createCheckpoint(
      {
        taskId: task.id, agentId: OWNER, progressSummary: 'checkpoint three',
        completedWork: 'did c', currentFindings: 'f3', unresolvedIssues: 'u3', nextSteps: 'continue',
        idempotency: { key: nextKey(), input: {} }, rootPath: root,
      },
      false,
    );

    return { taskId: task.id, baseline, cp1, cp2, cp3 };
  }

  function previewInput(taskId: string, target: string, agentId = OWNER) {
    return previewRevertTaskSchema.parse({ task_id: taskId, agent_id: agentId, target });
  }

  function applyInput(taskId: string, target: string, previewId: string, key: string, opts: { agentId?: string; reason?: string; forcePaths?: string[] } = {}) {
    return revertTaskChangesSchema.parse({
      task_id: taskId,
      agent_id: opts.agentId ?? OWNER,
      target,
      preview_id: previewId,
      reason: opts.reason ?? REASON,
      ...(opts.forcePaths ? { force_paths: opts.forcePaths } : {}),
      idempotency_key: key,
    });
  }

  /** Mirrors the HTTP route: hash input excludes the idempotency key. */
  function applyRevert(input: ReturnType<typeof revertTaskChangesSchema.parse>) {
    const { idempotency_key, ...rest } = input;
    return rollback.apply(input, root, { key: idempotency_key, input: rest });
  }

  function read(rel: string): string {
    return readFileSync(join(root, rel), 'utf8');
  }

  function snapshotCount(taskId: string): number {
    return (db.raw.prepare('SELECT COUNT(*) AS n FROM task_snapshots WHERE task_id = ?').get(taskId) as any).n;
  }

  function revertAppliedEvents(taskId: string): any[] {
    return db.raw
      .prepare(`SELECT * FROM events WHERE task_id = ? AND event_type = 'revert_applied' ORDER BY sequence ASC`)
      .all(taskId) as any[];
  }

  function idempotencyRows(key: string): number {
    return (db.raw.prepare('SELECT COUNT(*) AS n FROM idempotency_records WHERE key = ?').get(key) as any).n;
  }

  function allEventSequences(taskId: string): number[] {
    return (db.raw.prepare('SELECT sequence FROM events WHERE task_id = ? ORDER BY sequence ASC').all(taskId) as any[]).map(
      (r) => r.sequence,
    );
  }

  // ------------------------------------------------------------------ B11-1
  it('B11-1: rollback to checkpoint 2 restores only post-target changes', async () => {
    const { taskId, cp1, cp2, cp3 } = await seedThreeCheckpoints();

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    expect(preview.target.id).toBe(cp2.snapshot.id);
    expect(preview.effective.id).toBe(cp3.snapshot.id);
    const byPath = Object.fromEntries(preview.paths.map((p) => [p.path, p.status]));
    // cp3 changed tracked.txt + added file-c.txt relative to cp2.
    expect(byPath['tracked.txt']).toBe('clean'); // W == E, will be written back to T
    expect(byPath['file-c.txt']).toBe('delete');
    expect(preview.would_delete).toContain('file-c.txt');
    expect(preview.skipped_by_default).toEqual([]);

    const res = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()));
    expect(res.target_snapshot_id).toBe(cp2.snapshot.id);
    expect(res.failed_paths).toEqual([]);

    // Post-target changes reverted…
    expect(read('tracked.txt')).toBe('v2\n');
    expect(existsSync(join(root, 'file-c.txt'))).toBe(false);
    // …pre-target content untouched, unrelated files untouched.
    expect(read('file-a.txt')).toBe('a1\n');
    expect(read('file-b.txt')).toBe('b2\n');
    expect(read('keep.txt')).toBe('keep\n');
    expect(res.rolled_back_checkpoint_ids).toEqual([cp3.id]);
    expect(cp1.id).toBeTruthy();
  });

  // ------------------------------------------------------------------ B11-2
  it('B11-2: create/delete/rename/mode-change handled end to end', async () => {
    // Pre-claim files: doomed (will be deleted post-cp1), stay (renamed),
    // script.sh committed with mode 100755.
    writeFileSync(join(root, 'doomed.txt'), 'doomed\n');
    writeFileSync(join(root, 'stay.txt'), 'stay\n');
    writeFileSync(join(root, 'script.sh'), '#!/bin/sh\necho hi\n');
    fx.git(['add', '-A']);
    fx.git(['update-index', '--add', '--chmod=+x', 'script.sh']);
    fx.git(['commit', '-m', 'seed files']);
    const headBefore = fx.git(['rev-parse', 'HEAD']).trim();

    const task = await tasks.createTask({ projectId: 'p1', title: 'mode task' });
    const taskId = task.id;
    await tasks.claimTask(taskId, OWNER, { key: nextKey(), input: {} }, null, false, root);
    const cp1 = await checkpoints.createCheckpoint(
      { taskId: task.id, agentId: OWNER, progressSummary: 'cp1', idempotency: { key: nextKey(), input: {} }, rootPath: root },
      false,
    );

    // Post-cp1: create, delete, rename, modify, delete script.
    writeFileSync(join(root, 'created.txt'), 'created\n');
    rmSync(join(root, 'doomed.txt'));
    rmSync(join(root, 'stay.txt'));
    writeFileSync(join(root, 'renamed.txt'), 'stay\n');
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    rmSync(join(root, 'script.sh'));
    const cp2 = await checkpoints.createCheckpoint(
      { taskId: task.id, agentId: OWNER, progressSummary: 'cp2', idempotency: { key: nextKey(), input: {} }, rootPath: root },
      false,
    );

    // Recreate script identical to the target content (mode differs on win32).
    writeFileSync(join(root, 'script.sh'), '#!/bin/sh\necho hi\n');
    if (process.platform !== 'win32') {
      // Make the POSIX exec bit match cp1's recorded mode for the clean case.
      const { chmodSync } = await import('node:fs');
      chmodSync(join(root, 'script.sh'), 0o755);
    }

    const preview = rollback.preview(previewInput(taskId, cp1.snapshot.id), root);
    const byPath = Object.fromEntries(preview.paths.map((p) => [p.path, p.status]));
    expect(byPath['created.txt']).toBe('delete');
    expect(byPath['doomed.txt']).toBe('restore');
    expect(byPath['renamed.txt']).toBe('delete');
    expect(byPath['stay.txt']).toBe('restore');
    expect(byPath['tracked.txt']).toBe('clean');
    // Content matches target; mode-only difference (win32) still classifies clean.
    expect(byPath['script.sh']).toBe('clean');

    const res = applyRevert(applyInput(taskId, cp1.snapshot.id, preview.preview_id, nextKey()));
    expect(res.failed_paths).toEqual([]);
    expect(existsSync(join(root, 'created.txt'))).toBe(false);
    expect(existsSync(join(root, 'renamed.txt'))).toBe(false);
    expect(read('doomed.txt')).toBe('doomed\n');
    expect(read('stay.txt')).toBe('stay\n');
    expect(read('tracked.txt')).toBe('initial\n');
    expect(read('script.sh')).toBe('#!/bin/sh\necho hi\n');

    // HEAD untouched by capture/apply; git recorded 100755 for script.sh.
    expect(fx.git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    const ls = fx.git(['ls-tree', 'HEAD', 'script.sh']);
    expect(ls).toContain('100755');
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'script.sh')).mode & 0o111).toBeTruthy();
    }
    expect(cp2.id).toBeTruthy();
  });

  // ------------------------------------------------------------------ B11-3
  it('B11-3: baseline target equals whole-task revert (A6)', async () => {
    const { taskId, baseline, cp3 } = await seedThreeCheckpoints();

    const preview = rollback.preview(previewInput(taskId, 'baseline'), root);
    expect(preview.target.id).toBe(baseline.id);
    expect(preview.target.kind).toBe('baseline');
    expect(preview.effective.id).toBe(cp3.snapshot.id);

    const res = applyRevert(applyInput(taskId, 'baseline', preview.preview_id, nextKey()));
    expect(res.target_kind).toBe('baseline');
    expect(res.failed_paths).toEqual([]);

    // Whole task work undone: back to the tree captured at claim time.
    expect(read('tracked.txt')).toBe('initial\n');
    expect(existsSync(join(root, 'file-a.txt'))).toBe(false);
    expect(existsSync(join(root, 'file-b.txt'))).toBe(false);
    expect(existsSync(join(root, 'file-c.txt'))).toBe(false);
    expect(read('keep.txt')).toBe('keep\n');
    // All checkpoints are covered by a baseline revert.
    expect(res.rolled_back_checkpoint_ids.length).toBe(3);
  });

  // ------------------------------------------------------------------ B11-4
  it('B11-4: safety snapshot undo restores the pre-rollback tree', async () => {
    const { taskId, cp1 } = await seedThreeCheckpoints();

    const p1 = rollback.preview(previewInput(taskId, cp1.snapshot.id), root);
    const res1 = applyRevert(applyInput(taskId, cp1.snapshot.id, p1.preview_id, nextKey()));
    expect(read('tracked.txt')).toBe('v1\n');
    expect(existsSync(join(root, 'file-b.txt'))).toBe(false);
    expect(existsSync(join(root, 'file-c.txt'))).toBe(false);

    // Undo: target the safety snapshot captured before the apply.
    const safety = snapshots.getSnapshot(res1.safety_snapshot_id);
    expect(safety).not.toBeNull();
    expect(safety!.kind).toBe('safety');

    const p2 = rollback.preview(previewInput(taskId, safety!.id), root);
    const res2 = applyRevert(applyInput(taskId, safety!.id, p2.preview_id, nextKey()));
    expect(res2.failed_paths).toEqual([]);

    // Pre-rollback tree (the state at cp3) is back.
    expect(read('tracked.txt')).toBe('v3\n');
    expect(read('file-a.txt')).toBe('a1\n');
    expect(read('file-b.txt')).toBe('b2\n');
    expect(read('file-c.txt')).toBe('c3\n');
  });

  // ------------------------------------------------------------------ B11-5
  it('B11-5: preview is pure — writes nothing to tree, snapshots, events, refs', async () => {
    const { taskId, cp2 } = await seedThreeCheckpoints();

    const treeBefore = {
      tracked: read('tracked.txt'),
      a: read('file-a.txt'),
      b: read('file-b.txt'),
      c: read('file-c.txt'),
    };
    const snapCountBefore = snapshotCount(taskId);
    const eventsBefore = allEventSequences(taskId);
    const eventRowsBefore = db.raw
      .prepare('SELECT id, sequence, event_type, payload FROM events WHERE task_id = ? ORDER BY sequence ASC')
      .all(taskId);
    const refsBefore = fx.git(['for-each-ref', 'refs/workjournal/']);
    const headBefore = fx.git(['rev-parse', 'HEAD']).trim();
    const idemBefore = (db.raw.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get() as any).n;

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    expect(preview.preview_id.startsWith('wjp1.')).toBe(true);

    expect({
      tracked: read('tracked.txt'),
      a: read('file-a.txt'),
      b: read('file-b.txt'),
      c: read('file-c.txt'),
    }).toEqual(treeBefore);
    expect(snapshotCount(taskId)).toBe(snapCountBefore);
    expect(allEventSequences(taskId)).toEqual(eventsBefore);
    expect(
      db.raw.prepare('SELECT id, sequence, event_type, payload FROM events WHERE task_id = ? ORDER BY sequence ASC').all(taskId),
    ).toEqual(eventRowsBefore);
    expect(fx.git(['for-each-ref', 'refs/workjournal/'])).toBe(refsBefore);
    expect(fx.git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get() as any).n).toBe(idemBefore);
    expect(revertAppliedEvents(taskId).length).toBe(0);
  });

  // ------------------------------------------------------------------ B11-6
  it('B11-6: changed-since skipped by default; applied when listed in force_paths', async () => {
    const { taskId, cp2 } = await seedThreeCheckpoints();
    // Diverge the worktree from the effective snapshot after cp3.
    writeFileSync(join(root, 'tracked.txt'), 'diverged\n');

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const byPath = Object.fromEntries(preview.paths.map((p) => [p.path, p.status]));
    expect(byPath['tracked.txt']).toBe('changed-since');
    expect(preview.skipped_by_default).toContain('tracked.txt');

    // Default apply: diverged path is skipped, tree untouched.
    const res1 = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()));
    expect(read('tracked.txt')).toBe('diverged\n');
    expect(res1.skipped_paths.some((s) => s.path === 'tracked.txt')).toBe(true);
    expect(res1.skipped_paths.find((s) => s.path === 'tracked.txt')!.reason).toContain('force_paths');

    // Fresh preview after the tree changed: diverge tracked again so it is
    // changed-since relative to the new effective snapshot, then force it.
    writeFileSync(join(root, 'tracked.txt'), 'diverged-again\n');
    const preview2 = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    expect(preview2.preview_id).not.toBe(preview.preview_id);
    const byPath2 = Object.fromEntries(preview2.paths.map((p) => [p.path, p.status]));
    expect(byPath2['tracked.txt']).toBe('changed-since');
    const res2 = applyRevert(
      applyInput(taskId, cp2.snapshot.id, preview2.preview_id, nextKey(), { forcePaths: ['tracked.txt'] }),
    );
    expect(res2.reverted_paths).toContain('tracked.txt');
    expect(read('tracked.txt')).toBe('v2\n');
  });

  // ------------------------------------------------------------------ B11-7
  it('B11-7: conflict skipped by default (worktree diverged, target lacks path)', async () => {
    const { taskId, cp1 } = await seedThreeCheckpoints();
    // file-b exists at cp1+ but was deleted after cp1, then re-created with
    // diverged content: target(cp1) HAS file-b… instead use a file added after
    // cp1 that the target lacks, then diverge it from the effective snapshot.
    writeFileSync(join(root, 'file-b.txt'), 'b2\n'); // exists at cp2, not at cp1? it does exist at cp1? no — created at cp2.
    writeFileSync(join(root, 'file-c.txt'), 'diverged-c\n');

    const preview = rollback.preview(previewInput(taskId, cp1.snapshot.id), root);
    const byPath = Object.fromEntries(preview.paths.map((p) => [p.path, p.status]));
    // target=cp1 lacks file-b/file-c (created after cp1); effective=cp3 has them.
    // file-b content matches effective → delete; file-c diverged → conflict.
    expect(byPath['file-b.txt']).toBe('delete');
    expect(byPath['file-c.txt']).toBe('conflict');
    expect(preview.skipped_by_default).toContain('file-c.txt');

    const res = applyRevert(applyInput(taskId, cp1.snapshot.id, preview.preview_id, nextKey()));
    expect(res.deleted_paths).toContain('file-b.txt');
    expect(res.skipped_paths.some((s) => s.path === 'file-c.txt')).toBe(true);
    // Conflict path untouched.
    expect(read('file-c.txt')).toBe('diverged-c\n');
    // delete applies (worktree equals effective for file-b).
    expect(existsSync(join(root, 'file-b.txt'))).toBe(false);
  });

  // ------------------------------------------------------------------ B11-8
  it('B11-8: stale preview rejected when worktree changed since preview', async () => {
    const { taskId, cp2 } = await seedThreeCheckpoints();

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const snapBefore = snapshotCount(taskId);
    const idemKey = nextKey();

    // Mutate a planned path after previewing.
    writeFileSync(join(root, 'tracked.txt'), 'tampered\n');

    expect(() =>
      applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, idemKey)),
    ).toThrow(/preview expired: working tree changed, preview again/);

    // Nothing was recorded or changed by the rejected apply.
    expect(snapshotCount(taskId)).toBe(snapBefore);
    expect(revertAppliedEvents(taskId).length).toBe(0);
    expect(idempotencyRows(idemKey)).toBe(0);
    expect(read('tracked.txt')).toBe('tampered\n');

    // A new preview reflects the new fingerprint.
    const preview2 = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    expect(preview2.preview_id).not.toBe(preview.preview_id);
  });

  // ------------------------------------------------------------------ B11-9
  it('B11-9: idempotency — same key+input replays stored response; different input → conflict', async () => {
    const { taskId, cp2 } = await seedThreeCheckpoints();

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const key = nextKey();
    const input1 = applyInput(taskId, cp2.snapshot.id, preview.preview_id, key);
    const res1 = applyRevert(input1);

    expect(res1.rollback_snapshot_id).toBeTruthy();
    // Sequences: baseline=1, cp1=2, cp2=3, cp3=4, safety=5, rollback=6
    expect(snapshotCount(taskId)).toBe(6);
    expect(revertAppliedEvents(taskId).length).toBe(1);
    expect(idempotencyRows(key)).toBe(1);

    // Identical retry → deep-equal replay, no new snapshots/events.
    const res2 = applyRevert(input1);
    expect(res2).toEqual(res1);
    expect(snapshotCount(taskId)).toBe(6);
    expect(revertAppliedEvents(taskId).length).toBe(1);
    expect(idempotencyRows(key)).toBe(1);

    // Same key, different reason → IDEMPOTENCY_KEY_CONFLICT.
    const input2 = applyInput(taskId, cp2.snapshot.id, preview.preview_id, key, { reason: 'different reason' });
    await expect(applyRevert(input2)).rejects.toThrow(IdempotencyConflictError);
  });

  // ------------------------------------------------------------------ B11-10
  it('B11-10: auth — non-owner rejected; operator allowed; preview also authorized', async () => {
    const { taskId, cp1 } = await seedThreeCheckpoints();

    // Preview with non-owner → rejected (sync function).
    expect(() => rollback.preview(previewInput(taskId, cp1.snapshot.id, OTHER), root)).toThrow(OwnerMismatchError);

    // Apply with non-owner → rejected.
    const preview = rollback.preview(previewInput(taskId, cp1.snapshot.id), root);
    expect(() => applyRevert(applyInput(taskId, cp1.snapshot.id, preview.preview_id, nextKey(), { agentId: OTHER }))).toThrow(OwnerMismatchError);

    // Operator on preview → allowed.
    const opPreview = rollback.preview(previewInput(taskId, cp1.snapshot.id, OPERATOR), root);
    expect(opPreview.target.id).toBe(cp1.snapshot.id);

    // Operator on apply → allowed.
    const res = applyRevert(applyInput(taskId, cp1.snapshot.id, opPreview.preview_id, nextKey(), { agentId: OPERATOR }));
    expect(res.failed_paths).toEqual([]);
    expect(read('tracked.txt')).toBe('v1\n');
  });

  // ------------------------------------------------------------------ B11-11
  it('B11-11: reason required (schema rejects empty)', async () => {
    const { taskId, cp1 } = await seedThreeCheckpoints();
    const preview = rollback.preview(previewInput(taskId, cp1.snapshot.id), root);
    const input = { ...applyInput(taskId, cp1.snapshot.id, preview.preview_id, nextKey()), reason: '' };
    expect(() => revertTaskChangesSchema.parse(input)).toThrow();
  });

  // ------------------------------------------------------------------ B11-12
  it('B11-12: rejections — no-op target, cross-task target, path escape', async () => {
    const { taskId, cp2, cp3 } = await seedThreeCheckpoints();

    // No-op: target == effective (cp3 is effective) → preview throws.
    expect(() => rollback.preview(previewInput(taskId, cp3.snapshot.id), root)).toThrow(/nothing to roll back/);

    // Cross-task target: create another task, use its baseline → preview throws.
    const otherTask = await tasks.createTask({ projectId: 'p1', title: 'other' });
    await tasks.claimTask(otherTask.id, OWNER, { key: nextKey(), input: {} }, null, false, root);
    const otherBaseline = snapshots.getBaselineSnapshot(otherTask.id)!;
    expect(() => rollback.preview(previewInput(taskId, otherBaseline.id), root)).toThrow(/different task/);

    // Path traversal in force_paths.
    const p3 = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    expect(() => applyRevert(applyInput(taskId, cp2.snapshot.id, p3.preview_id, nextKey(), { forcePaths: ['../etc/passwd'] }))).toThrow(/escapes the project root/);
    expect(() => applyRevert(applyInput(taskId, cp2.snapshot.id, p3.preview_id, nextKey(), { forcePaths: ['/absolute/path'] }))).toThrow(/escapes the project root/);
    expect(() => applyRevert(applyInput(taskId, cp2.snapshot.id, p3.preview_id, nextKey(), { forcePaths: ['.workjournal/secret.db'] }))).toThrow(/protected .workjournal/);
  });

  // ------------------------------------------------------------------ B11-13
  it('B11-13: degraded target reported not-restorable in preview; apply refuses', async () => {
    const { taskId, cp1, cp2, cp3 } = await seedThreeCheckpoints();

    // Simulate a capture failure on cp2 (not the effective snapshot).
    db.raw
      .prepare('UPDATE task_snapshots SET capture_status = ?, commit_sha = NULL WHERE id = ?')
      .run('degraded', cp2.snapshot.id);

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    expect(preview.paths.length).toBeGreaterThan(0);
    for (const p of preview.paths) {
      expect(p.status).toBe('not-restorable');
    }
    expect(preview.would_restore).toEqual([]);
    expect(preview.would_delete).toEqual([]);

    // Apply throws even if union happens to be empty.
    expect(() => applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()))).toThrow(/degraded/);
    // Nothing changed: no new snapshots, no event, tree untouched.
    expect(read('tracked.txt')).toBe('v3\n');
    expect(revertAppliedEvents(taskId).length).toBe(0);
  });

  // ------------------------------------------------------------------ B11-14
  it('B11-14: records preserved — append-only sequences; checkpoints/snapshots never mutated; rolled-back flag derived', async () => {
    const { taskId, cp1, cp2, cp3 } = await seedThreeCheckpoints();
    const preSeq = allEventSequences(taskId);

    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const res = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()));
    const postSeq = allEventSequences(taskId);

    // Event sequence monotonic append: rollback apply creates 3 events (safety snapshot, rollback snapshot, revert_applied).
    expect(postSeq.length).toBe(preSeq.length + 3);
    expect(postSeq[postSeq.length - 1]).toBeGreaterThan(preSeq[preSeq.length - 1]);

    // Checkpoint rows unchanged (id, created_at, fields intact).
    const ckRows = db.raw.prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
    expect(ckRows.length).toBe(3);
    expect(ckRows[0].id).toBe(cp1.id);
    expect(ckRows[2].id).toBe(cp3.id);

    // Snapshot rows unchanged; rollback linkage set on the NEW rollback snapshot.
    const snapRows = db.raw.prepare('SELECT id, kind, target_snapshot_id, safety_snapshot_id FROM task_snapshots WHERE task_id = ? ORDER BY sequence ASC').all(taskId) as any[];
    const rollbackSnap = snapRows.find((s) => s.kind === 'rollback');
    expect(rollbackSnap).toBeTruthy();
    expect(rollbackSnap!.target_snapshot_id).toBe(cp2.snapshot.id);
    expect(rollbackSnap!.safety_snapshot_id).toBeTruthy();

    // Rolled-back flag is derived at read time (not stored).
    const view = getRollbackView(db, taskId);
    expect(view.rolledBackCheckpointIds.has(cp3.id)).toBe(true);
    expect(view.rolledBackCheckpointIds.has(cp2.id)).toBe(false);
    expect(view.workingCheckpoint!.id).toBe(cp2.id);
  });

  // ------------------------------------------------------------------ B11-15
  it('B11-15: multiple rollbacks — derivation of rolled-back set + effective snapshot correct', async () => {
    const { taskId, cp1, cp2, cp3 } = await seedThreeCheckpoints();

    // First rollback: to cp2 (covers cp3).
    let preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const res1 = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()));
    let view = getRollbackView(db, taskId);
    expect(view.rolledBackCheckpointIds.has(cp3.id)).toBe(true);
    expect(view.rolledBackCheckpointIds.has(cp2.id)).toBe(false);
    expect(view.workingCheckpoint!.id).toBe(cp2.id);
    expect(view.latestRollback!.target_snapshot_id).toBe(cp2.snapshot.id);
    expect(view.latestRollback!.rolled_back_checkpoint_ids).toEqual([cp3.id]);
    expect(view.rb.effective!.id).toBe(res1.rollback_snapshot_id); // effective = rollback snapshot

    // Second rollback: to cp1 (covers cp2).
    preview = rollback.preview(previewInput(taskId, cp1.snapshot.id), root);
    const res2 = applyRevert(applyInput(taskId, cp1.snapshot.id, preview.preview_id, nextKey()));
    view = getRollbackView(db, taskId);
    expect(view.rolledBackCheckpointIds.has(cp2.id)).toBe(true);
    expect(view.rolledBackCheckpointIds.has(cp3.id)).toBe(true);
    expect(view.rolledBackCheckpointIds.has(cp1.id)).toBe(false);
    expect(view.workingCheckpoint!.id).toBe(cp1.id);
    expect(view.latestRollback!.target_snapshot_id).toBe(cp1.snapshot.id);
    // Both rollbacks recorded.
    expect(view.rb.rollbacks.length).toBe(2);
    expect(view.latestRollback!.target_snapshot_id).toBe(cp1.snapshot.id);
    // latestRollback reflects ALL checkpoints between its target (cp1) and its safety snapshot,
    // which includes cp2 AND cp3 (both were after cp1 when safety was captured).
    expect(view.latestRollback!.rolled_back_checkpoint_ids).toEqual([cp2.id, cp3.id]);
    expect(view.rb.effective!.id).toBe(res2.rollback_snapshot_id);
    // The apply response includes ALL checkpoints rolled back by this apply.
    expect(res2.rolled_back_checkpoint_ids).toEqual([cp2.id, cp3.id]);
  });

  // ------------------------------------------------------------------ B11-16
  it('B11-16: effective snapshot correctness — change set after rollback = diff(baseline, post-rollback)', async () => {
    const { taskId, baseline, cp2, cp3 } = await seedThreeCheckpoints();

    // Rollback to cp2.
    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const res = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()));

    // Effective snapshot is the rollback snapshot.
    const effective = snapshots.getSnapshot(res.rollback_snapshot_id);
    expect(effective).not.toBeNull();
    expect(effective!.kind).toBe('rollback');

    // Diff baseline -> effective equals the expected working tree (cp2's tree).
    const diff = diffRefs(root, baseline.commit_sha!, effective!.commit_sha!);
    const paths = diff.changedFiles.map((f: any) => f.path).sort();
    expect(paths).toContain('file-a.txt');
    expect(paths).toContain('file-b.txt');
    expect(paths).not.toContain('file-c.txt'); // was added after cp2, now gone
    // tracked.txt back to v2; modified vs baseline.
    const tracked = diff.changedFiles.find((f: any) => f.path === 'tracked.txt');
    expect(tracked.status).toBe('modified');

    // Drift vs effective (vs_worktree) shows no changes since we just restored.
    const drift = snapshots.getTaskChanges(taskId, { comparison: 'vs_worktree' }, root);
    expect(drift.drift?.changed_files.length ?? 0).toBe(0);
  });

  // ------------------------------------------------------------------ B11-17
  it('B11-17: resume/export determinism + JSON/Markdown agreement; handoffJsonSchema validates', async () => {
    const { taskId, cp1, cp2, cp3 } = await seedThreeCheckpoints();

    // Rollback to cp2.
    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id), root);
    const res = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey()));

    // Build resume, JSON, Markdown.
    const resumeText = await resume.build(taskId);
    const json = await jsonExport.exportTask(taskId);
    const md = await mdExport.exportTask(taskId);

    // Determinism: same records → same output (strip non-deterministic fields).
    const stripNonDeterministic = (o: any) => {
      const cloned = JSON.parse(JSON.stringify(o));
      cloned.exported_at = 'FIXED';
      return cloned;
    };
    const j1 = stripNonDeterministic(json);
    const j2 = stripNonDeterministic(await jsonExport.exportTask(taskId));
    expect(j1).toEqual(j2);

    // JSON/Markdown agreement on working vs rolled-back.
    const view = getRollbackView(db, taskId);
    const workingId = view.workingCheckpoint!.id;
    const rolledIds = Array.from(view.rolledBackCheckpointIds);

    expect(j1.checkpoint.id).toBe(workingId);
    expect(j1.checkpoints.find((c: any) => c.id === workingId)?.rolled_back).toBe(false);
    for (const id of rolledIds) {
      expect(j1.checkpoints.find((c: any) => c.id === id)?.rolled_back).toBe(true);
    }

    // Markdown has the working checkpoint section with its id.
    expect(md).toContain(`## Working Checkpoint`);
    expect(md).toContain(`- **ID:** ${workingId}`);
    // Rolled-back section contains cp3 id.
    expect(md).toContain(`## Rolled-back Checkpoints`);
    expect(md).toContain(cp3.id);
    // And not the working one.
    expect(md).not.toContain(`- **${cp2.id}**`); // cp2 is working, not in rolled-back list

    // handoffJsonSchema validates the JSON export.
    const handoff = handoffJsonSchema.parse(j1);
    expect(handoff.format_version).toBe(2);
    expect(handoff.checkpoint).not.toBeNull();
    expect(handoff.rollback.present).toBe(true);
    expect(handoff.snapshots.effective_kind).toBe('rollback');
  });

  // ------------------------------------------------------------------ B11-18
  it('B11-18: continuity — Agent A cp1-3; operator rolls back to cp2; Agent B resumes sees notice, working cp2, cp3 marked rolled back, changes vs effective', async () => {
    const { taskId, cp1, cp2, cp3 } = await seedThreeCheckpoints();

    // Agent A did checkpoints 1-3 (seeded).
    // Operator rolls back to cp2.
    const preview = rollback.preview(previewInput(taskId, cp2.snapshot.id, OPERATOR), root);
    const res = applyRevert(applyInput(taskId, cp2.snapshot.id, preview.preview_id, nextKey(), { agentId: OPERATOR }));

    // Agent B resumes: build resume context.
    const resumeText = await resume.build(taskId);

    // Rollback Notice present.
    expect(resumeText).toContain('## Rollback Notice');
    expect(resumeText).toContain('Working tree rolled back');
    expect(resumeText).toContain(cp2.id); // target checkpoint id in notice
    expect(resumeText).toContain(cp3.id); // rolled-back cp3 id in notice

    // Working Checkpoint section (not "Latest Checkpoint").
    expect(resumeText).toContain('## Working Checkpoint');
    expect(resumeText).toContain(`- **ID:** ${cp2.id}`);

    // Rolled-back checkpoints section with "not reflected" marker.
    expect(resumeText).toContain('## Rolled-back Checkpoints');
    expect(resumeText).toContain('not reflected');
    expect(resumeText).toContain(cp3.id);
    expect(resumeText).toContain('f3'); // cp3 findings shown

    // Working-tree Changes section + Safety snapshot.
    expect(resumeText).toContain('## Working-tree Changes (vs baseline)');
    expect(resumeText).toContain('Safety snapshot:');
    expect(resumeText).toContain(res.safety_snapshot_id);

    // Handoff export validates v2 format with same semantics.
    const json = await jsonExport.exportTask(taskId);
    const handoff = handoffJsonSchema.parse(json);
    expect(handoff.checkpoint!.id).toBe(cp2.id);
    expect(handoff.checkpoints.find((c) => c.id === cp3.id)?.rolled_back).toBe(true);
    expect(handoff.checkpoints.find((c) => c.id === cp2.id)?.rolled_back).toBe(false);
    expect(handoff.rollback.present).toBe(true);
    expect(handoff.rollback.latest!.rolled_back_checkpoint_ids).toEqual([cp3.id]);
  });
});
