import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { EventService } from '../domain/event-service.js';
import type { RollbackContext } from '../domain/snapshot-service.js';
import { getRollbackView } from '../domain/rollback-view.js';
import { DEFAULT_CONTEXT_SIZE_LIMIT } from '@workjournal/shared';

/** One section of the resume output, with its truncation priority (spec §10.3). */
type Mode = { rolledBack: 'full' | 'compact'; events: 'full' | 'few' | 'none' };

export class ResumeBuilder {
  private tasks: TaskService;
  private decisions: DecisionService;
  private events: EventService;

  constructor(private db: Database) {
    this.tasks = new TaskService(db);
    this.decisions = new DecisionService(db);
    this.events = new EventService(db);
  }

  async build(taskId: string, sizeLimit = DEFAULT_CONTEXT_SIZE_LIMIT): Promise<string> {
    const task = await this.tasks.getTask(taskId);

    // ---- Shared read-time rollback view (B4/B7/B8) — one derivation, so the
    // resume context, JSON and Markdown exports can never disagree. ----
    const view = getRollbackView(this.db, taskId);
    const { rb, workingCheckpoint, rolledBackCheckpoints, latestRollback, snapshotById } = view;

    const activeDecisions = await this.decisions.listDecisions(taskId, false);
    const allEvents = await this.events.listEvents({ taskId, limit: 200 });

    // ---- Section builders ----
    const header = this.headerSection(task);

    const rollbackNotice = this.rollbackNoticeSection(rb, snapshotById);

    const workingCheckpointSection = this.checkpointSection(workingCheckpoint, rb.rollbacks.length > 0);

    const decisionsSection = this.decisionsSection(activeDecisions, latestRollback, snapshotById);

    const progressSection = this.progressSection(workingCheckpoint);

    const unresolvedSection = workingCheckpoint?.unresolved_issues
      ? `## Unresolved Issues\n${workingCheckpoint.unresolved_issues}`
      : '';

    const changesSection = this.changesSection(rb, latestRollback);

    const rolledBackSection = (mode: Mode) =>
      this.rolledBackSection(rolledBackCheckpoints, mode, latestRollback);

    const eventsSection = (mode: Mode) => this.eventsSection(allEvents, mode);
    const assemble = (mode: Mode): string =>
      [
        header,
        rollbackNotice,
        workingCheckpointSection,
        decisionsSection,
        progressSection,
        unresolvedSection,
        changesSection,
        rolledBackSection(mode),
        eventsSection(mode),
      ]
        .filter((s) => s && s.length > 0)
        .join('\n');

    // ---- Size management (spec §10.3): expendable detail falls first ----
    let mode: Mode = { rolledBack: 'full', events: 'full' };
    let output = assemble(mode);
    let truncationNote = '';
    if (output.length > sizeLimit) {
      mode = { rolledBack: 'compact', events: 'full' };
      output = assemble(mode);
      truncationNote =
        '\n\n> **Rolled-back checkpoint details truncated** to fit the context limit (findings omitted).';
    }
    if (output.length > sizeLimit) {
      mode = { ...mode, events: 'few' };
      output = assemble(mode);
      truncationNote =
        '\n\n> **Rolled-back details and older events truncated** to fit the context limit.';
    }
    if (output.length > sizeLimit) {
      // Last resort: hard slice, keeping whatever note explains what is missing.
      const note =
        truncationNote || '\n\n> **Context truncated.** Some content may have been omitted.';
      output = output.slice(0, Math.max(0, sizeLimit - note.length)) + note;
    } else {
      output += truncationNote;
    }

    return output;
  }

  private headerSection(task: any): string {
    const sections: string[] = [];
    sections.push(`# Task: ${task.title}`);
    sections.push(`- **ID:** ${task.id}`);
    sections.push(`- **Status:** ${task.status}`);
    sections.push(`- **Priority:** ${task.priority}`);
    sections.push(`- **Owner:** ${task.owner || 'unclaimed'}`);
    if (task.objective) sections.push(`- **Objective:** ${task.objective}`);
    if (task.acceptance_criteria?.length) {
      sections.push(`- **Acceptance Criteria:**`);
      for (const c of task.acceptance_criteria) sections.push(`  - ${c}`);
    }
    return sections.join('\n');
  }

  /**
   * Prominent rollback notice directly under the header (B7): target, time,
   * actor, reason and the rolled-back checkpoint ids — newest rollback first.
   */
  private rollbackNoticeSection(rb: RollbackContext, snapshotById: Map<string, any>): string {
    if (rb.rollbacks.length === 0) return '';
    const lines: string[] = ['', '## Rollback Notice'];
    for (const r of [...rb.rollbacks].reverse()) {
      const target = snapshotById.get(r.target_snapshot_id);
      const targetDesc =
        target?.kind === 'checkpoint' && target.checkpoint_id
          ? `checkpoint ${target.checkpoint_id} (snapshot ${r.target_snapshot_id}, seq ${r.target_sequence ?? '?'})`
          : `snapshot ${r.target_snapshot_id} (${target?.kind ?? 'unknown'}, seq ${r.target_sequence ?? '?'})`;
      lines.push(
        `> **Working tree rolled back** to ${targetDesc} at ${r.created_at} by ${r.actor}.`,
      );
      lines.push(`> Reason: ${r.reason || '(no reason recorded)'}`);
      lines.push(
        `> Rolled-back checkpoints: ${
          r.rolled_back_checkpoint_ids.length ? r.rolled_back_checkpoint_ids.join(', ') : 'none'
        }`,
      );
      lines.push('');
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  private checkpointSection(checkpoint: any, hasRollback: boolean): string {
    const heading = hasRollback ? '## Working Checkpoint' : '## Latest Checkpoint';
    if (!checkpoint) {
      return hasRollback
        ? `${heading}\n- **None** — every checkpoint has been rolled back; re-checkpoint before continuing.`
        : '';
    }
    const lines = [heading];
    lines.push(`- **ID:** ${checkpoint.id}`);
    lines.push(`- **Progress:** ${checkpoint.progress_summary}`);
    if (checkpoint.next_steps) lines.push(`- **Next Steps:** ${checkpoint.next_steps}`);
    return lines.join('\n');
  }

  /**
   * Active decisions; after a rollback, decisions recorded after the rollback
   * target are marked so the resuming agent knows they postdate its checkpoint.
   */
  private decisionsSection(activeDecisions: any[], latestRollback: any, snapshotById: Map<string, any>): string {
    if (!activeDecisions || activeDecisions.length === 0) return '';
    const target = latestRollback ? snapshotById.get(latestRollback.target_snapshot_id) : null;
    const lines = ['', '## Active Decisions'];
    for (const d of activeDecisions) {
      const afterTarget = target && d.created_at && d.created_at > target.captured_at;
      lines.push(`- **${d.statement}**${afterTarget ? ' *(recorded after rollback target)*' : ''}`);
      if (d.rationale) lines.push(`  - Rationale: ${d.rationale}`);
    }
    return lines.join('\n');
  }

  private progressSection(checkpoint: any): string {
    if (!checkpoint?.completed_work && !checkpoint?.current_findings) return '';
    const lines = ['', '## Progress'];
    if (checkpoint.completed_work) lines.push(`### Completed Work\n${checkpoint.completed_work}`);
    if (checkpoint.current_findings) lines.push(`### Current Findings\n${checkpoint.current_findings}`);
    return lines.join('\n');
  }

  /**
   * Working-tree changes from the EFFECTIVE snapshot (diff baseline → effective,
   * stored summary — no git access needed here) plus the most recent safety
   * snapshot id (B7).
   */
  private changesSection(rb: RollbackContext, latestRollback: any): string {
    const effective = rb.effective;
    if (!effective) return '';
    const lines = ['', '## Working-tree Changes (vs baseline)'];
    lines.push(
      `- **Effective snapshot:** ${effective.id} (${effective.kind}, seq ${effective.sequence}${
        effective.capture_status === 'degraded' ? ', degraded' : ''
      })`,
    );
    const files = effective.changed_vs_baseline ?? [];
    lines.push(
      `- **Change set:** ${files.length} file(s) +${effective.insertions_vs_baseline}/-${effective.deletions_vs_baseline}`,
    );
    for (const f of files.slice(0, 20)) lines.push(`  - ${f.status} ${f.path}`);
    if (files.length > 20) lines.push(`  - ... ${files.length - 20} more`);
    if (latestRollback?.safety_snapshot_id) {
      lines.push(`- **Safety snapshot:** ${latestRollback.safety_snapshot_id} (undo target)`);
    }
    return lines.join('\n');
  }

  /** Compact rolled-back checkpoints: findings visible, marked not reflected. */
  private rolledBackSection(
    rolledBackCheckpoints: any[],
    mode: Mode,
    latestRollback: any,
  ): string {
    if (rolledBackCheckpoints.length === 0) return '';
    const lines = ['', '## Rolled-back Checkpoints'];
    lines.push('_These checkpoints are **not reflected in the working tree**._');
    if (latestRollback) {
      lines.push(`_Rolled back by the rollback at ${latestRollback.created_at} — ${latestRollback.reason || 'no reason recorded'}._`);
    }
    if (mode.rolledBack === 'compact') {
      lines.push(`(${rolledBackCheckpoints.length} checkpoint(s) — details truncated to fit context)`);
      return lines.join('\n');
    }
    for (const c of rolledBackCheckpoints) {
      lines.push(`- **${c.id}** (${c.created_at}) — ${c.progress_summary}`);
      if (c.current_findings) lines.push(`  - Findings: ${c.current_findings}`);
      if (c.unresolved_issues) lines.push(`  - Open: ${c.unresolved_issues}`);
    }
    return lines.join('\n');
  }

  private eventsSection(allEvents: any[], mode: Mode): string {
    if (mode.events === 'none') return '';
    const limit = mode.events === 'few' ? 5 : 20;
    const relevant = allEvents.slice(-limit);
    if (relevant.length === 0) return '';
    const lines = ['', '## Recent Events'];
    for (const e of relevant) {
      lines.push(`- [${e.created_at}] ${e.actor}: ${e.event_type}`);
    }
    return lines.join('\n');
  }
}
