import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { CheckpointService } from '../domain/checkpoint-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { EventService } from '../domain/event-service.js';
import { DEFAULT_CONTEXT_SIZE_LIMIT } from '@workjournal/shared';

export class ResumeBuilder {
  private tasks: TaskService;
  private checkpoints: CheckpointService;
  private decisions: DecisionService;
  private events: EventService;

  constructor(private db: Database) {
    this.tasks = new TaskService(db);
    this.checkpoints = new CheckpointService(db);
    this.decisions = new DecisionService(db);
    this.events = new EventService(db);
  }

  async build(taskId: string, sizeLimit = DEFAULT_CONTEXT_SIZE_LIMIT): Promise<string> {
    const task = await this.tasks.getTask(taskId);

    const checkpoint = await this.checkpoints.getLatestCheckpoint(taskId);
    const activeDecisions = await this.decisions.listDecisions(taskId, false);
    const allEvents = await this.events.listEvents(taskId);

    const sections: string[] = [];

    // Section 1: Task identity
    sections.push(`# Task: ${task.title}`);
    sections.push(`- **ID:** ${task.id}`);
    sections.push(`- **Status:** ${task.status}`);
    sections.push(`- **Priority:** ${task.priority}`);
    sections.push(`- **Owner:** ${task.owner || 'unclaimed'}`);
    sections.push(`- **Version:** ${task.version}`);
    if (task.objective) sections.push(`- **Objective:** ${task.objective}`);
    if (task.acceptance_criteria.length > 0) {
      sections.push(`- **Acceptance Criteria:**`);
      task.acceptance_criteria.forEach((c: string) => sections.push(`  - ${c}`));
    }

    // Section 2: Latest checkpoint + next steps
    if (checkpoint) {
      sections.push(`\n## Latest Checkpoint`);
      sections.push(`- **Progress:** ${checkpoint.progress_summary}`);
      if (checkpoint.next_steps) sections.push(`- **Next Steps:** ${checkpoint.next_steps}`);
    }

    // Section 3: Active decisions
    if (activeDecisions.length > 0) {
      sections.push(`\n## Active Decisions`);
      for (const d of activeDecisions) {
        sections.push(`- **${d.statement}**`);
        if (d.rationale) sections.push(`  - Rationale: ${d.rationale}`);
      }
    }

    // Section 4: Completed work + findings
    if (checkpoint?.completed_work || checkpoint?.current_findings) {
      sections.push(`\n## Progress`);
      if (checkpoint.completed_work) sections.push(`### Completed Work\n${checkpoint.completed_work}`);
      if (checkpoint.current_findings) sections.push(`### Current Findings\n${checkpoint.current_findings}`);
    }

    // Section 5: Unresolved issues
    if (checkpoint?.unresolved_issues) {
      sections.push(`\n## Unresolved Issues`);
      sections.push(checkpoint.unresolved_issues);
    }

    // Section 6: Events since last checkpoint
    const sinceSeq = checkpoint ? 0 : 0;
    const relevantEvents = allEvents.filter((e: any) => e.sequence >= sinceSeq);
    if (relevantEvents.length > 0) {
      sections.push(`\n## Recent Events`);
      for (const e of relevantEvents.slice(-20)) {
        sections.push(`- [${e.created_at}] ${e.actor}: ${e.event_type}`);
      }
    }

    let output = sections.join('\n');

    if (output.length > sizeLimit) {
      let truncated = output.slice(0, sizeLimit);
      truncated += `\n\n> **Context truncated.** Some older events may have been omitted.`;
      output = truncated;
    }

    return output;
  }
}
