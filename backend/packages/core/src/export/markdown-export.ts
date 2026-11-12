import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { getRollbackView } from '../domain/rollback-view.js';
import { filterSecrets } from './secret-filter.js';

/**
 * Markdown handoff export, HANDOFF.md v2 (Addendum B §B8). Working vs
 * rolled-back checkpoint classification comes from the same `getRollbackView`
 * as the JSON export and the resume context, so all three always agree.
 * No raw diffs — summaries and snapshot refs only; secrets filtered.
 */
export class MarkdownExporter {
  constructor(private db: Database) {}

  async exportTask(taskId: string): Promise<string> {
    const task = await new TaskService(this.db).getTask(taskId);

    const decisions = new DecisionService(this.db);
    const activeDecisions = await decisions.listDecisions(taskId, false);

    const view = getRollbackView(this.db, taskId);
    const { rb, workingCheckpoint, rolledBackCheckpoints, latestRollback, snapshotById } = view;
    const hasRollback = rb.rollbacks.length > 0;

    const lines: string[] = [];

    lines.push(`# Handoff: ${filterSecrets(task.title)}`);
    lines.push('');
    lines.push(`> Generated: ${new Date().toISOString()}`);
    lines.push(`> Format: HANDOFF.md v2`);
    lines.push('');

    lines.push(`## Task`);
    lines.push(`- **ID:** ${task.id}`);
    lines.push(`- **Status:** ${task.status}`);
    lines.push(`- **Priority:** ${task.priority}`);
    lines.push(`- **Owner:** ${task.owner || 'unclaimed'}`);
    if (task.objective) lines.push(`- **Objective:** ${filterSecrets(task.objective)}`);

    const criteria = task.acceptance_criteria;
    if (criteria.length > 0) {
      lines.push(`- **Acceptance Criteria:**`);
      criteria.forEach((c: string) => lines.push(`  - ${filterSecrets(c)}`));
    }

    // ---- Working checkpoint (agrees with JSON `checkpoint`) ----
    if (workingCheckpoint) {
      lines.push('');
      lines.push(hasRollback ? `## Working Checkpoint` : `## Latest Checkpoint`);
      lines.push(`- **ID:** ${workingCheckpoint.id}`);
      lines.push(`**Progress:** ${filterSecrets(workingCheckpoint.progress_summary)}`);
      if (workingCheckpoint.completed_work) lines.push(`\n### Completed Work\n${filterSecrets(workingCheckpoint.completed_work)}`);
      if (workingCheckpoint.current_findings) lines.push(`\n### Current Findings\n${filterSecrets(workingCheckpoint.current_findings)}`);
      if (workingCheckpoint.unresolved_issues) lines.push(`\n### Unresolved Issues\n${filterSecrets(workingCheckpoint.unresolved_issues)}`);
      if (workingCheckpoint.next_steps) lines.push(`\n### Next Steps\n${filterSecrets(workingCheckpoint.next_steps)}`);
    } else if (hasRollback) {
      lines.push('');
      lines.push(`## Working Checkpoint`);
      lines.push(`- **None** — every checkpoint has been rolled back; re-checkpoint before continuing.`);
    }

    // ---- Rollback history (agrees with JSON `rollback`) ----
    if (hasRollback) {
      lines.push('');
      lines.push(`## Rollback`);
      for (const r of [...rb.rollbacks].reverse()) {
        const target = snapshotById.get(r.target_snapshot_id);
        const targetDesc =
          target?.kind === 'checkpoint' && target.checkpoint_id
            ? `checkpoint ${target.checkpoint_id} (snapshot ${r.target_snapshot_id})`
            : `snapshot ${r.target_snapshot_id} (${target?.kind ?? 'unknown'})`;
        lines.push(`- Rolled back at ${r.created_at} by ${r.actor} to ${targetDesc}`);
        lines.push(`  - Reason: ${filterSecrets(r.reason || '(no reason recorded)')}`);
        lines.push(
          `  - Rolled-back checkpoints: ${
            r.rolled_back_checkpoint_ids.length
              ? r.rolled_back_checkpoint_ids.join(', ')
              : 'none'
          }`,
        );
      }
      const effective = rb.effective;
      if (effective) {
        lines.push(
          `- Effective snapshot: ${effective.id} (${effective.kind}, seq ${effective.sequence})`,
        );
      }
    }

    // ---- Rolled-back checkpoints (agrees with JSON `checkpoints[].rolled_back`) ----
    if (rolledBackCheckpoints.length > 0) {
      lines.push('');
      lines.push(`## Rolled-back Checkpoints`);
      lines.push(`_These checkpoints are **not reflected in the working tree**._`);
      if (latestRollback) {
        lines.push(
          `_Rolled back by the rollback at ${latestRollback.created_at} — ${filterSecrets(
            latestRollback.reason || 'no reason recorded',
          )}._`,
        );
      }
      for (const c of rolledBackCheckpoints) {
        lines.push(`- **${c.id}** (${c.created_at}) — ${filterSecrets(c.progress_summary)}`);
        if (c.current_findings) lines.push(`  - Findings: ${filterSecrets(c.current_findings)}`);
        if (c.unresolved_issues) lines.push(`  - Open: ${filterSecrets(c.unresolved_issues)}`);
      }
    }

    if (activeDecisions.length > 0) {
      lines.push('');
      lines.push(`## Active Decisions`);
      for (const d of activeDecisions as Array<{ statement: string; rationale: string | null }>) {
        lines.push(`- **${filterSecrets(d.statement)}**`);
        if (d.rationale) lines.push(`  - Rationale: ${filterSecrets(d.rationale)}`);
      }
    }

    return lines.join('\n');
  }
}
