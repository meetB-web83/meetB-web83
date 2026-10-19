import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { CheckpointService } from '../domain/checkpoint-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { filterSecrets } from './secret-filter.js';

export class MarkdownExporter {
  constructor(private db: Database) {}

  async exportTask(taskId: string): Promise<string> {
    const task = await new TaskService(this.db).getTask(taskId);

    const checkpoints = new CheckpointService(this.db);
    const decisions = new DecisionService(this.db);
    const checkpoint = await checkpoints.getLatestCheckpoint(taskId);
    const activeDecisions = await decisions.listDecisions(taskId, false);

    const lines: string[] = [];

    lines.push(`# Handoff: ${filterSecrets(task.title)}`);
    lines.push('');
    lines.push(`> Generated: ${new Date().toISOString()}`);
    lines.push(`> Format: HANDOFF.md v1`);
    lines.push('');

    lines.push(`## Task`);
    lines.push(`- **ID:** ${task.id}`);
    lines.push(`- **Status:** ${task.status}`);
    lines.push(`- **Priority:** ${task.priority}`);
    lines.push(`- **Owner:** ${task.owner || 'unclaimed'}`);
    lines.push(`- **Version:** ${task.version}`);
    if (task.objective) lines.push(`- **Objective:** ${filterSecrets(task.objective)}`);

    const criteria = task.acceptance_criteria;
    if (criteria.length > 0) {
      lines.push(`- **Acceptance Criteria:**`);
      criteria.forEach((c: string) => lines.push(`  - ${filterSecrets(c)}`));
    }

    if (checkpoint) {
      lines.push('');
      lines.push(`## Latest Checkpoint`);
      lines.push(`**Progress:** ${filterSecrets(checkpoint.progress_summary)}`);
      if (checkpoint.completed_work) lines.push(`\n### Completed Work\n${filterSecrets(checkpoint.completed_work)}`);
      if (checkpoint.current_findings) lines.push(`\n### Current Findings\n${filterSecrets(checkpoint.current_findings)}`);
      if (checkpoint.unresolved_issues) lines.push(`\n### Unresolved Issues\n${filterSecrets(checkpoint.unresolved_issues)}`);
      if (checkpoint.next_steps) lines.push(`\n### Next Steps\n${filterSecrets(checkpoint.next_steps)}`);
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
