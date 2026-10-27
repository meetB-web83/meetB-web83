import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { CheckpointService } from '../domain/checkpoint-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { EventService } from '../domain/event-service.js';
import { filterSecretsDeep } from './secret-filter.js';

export class JsonExporter {
  constructor(private db: Database) {}

  async exportTask(taskId: string) {
    const task = await new TaskService(this.db).getTask(taskId);

    const checkpoints = new CheckpointService(this.db);
    const decisions = new DecisionService(this.db);
    const events = new EventService(this.db);

    const checkpoint = await checkpoints.getLatestCheckpoint(taskId);
    const allDecisions = await decisions.listDecisions(taskId, true);
    const allEvents = await events.listEvents({ taskId });

    const handoff = {
      format_version: 1,
      exported_at: new Date().toISOString(),
      task: {
        id: task.id,
        project_id: task.project_id,
        title: task.title,
        objective: task.objective,
        acceptance_criteria: task.acceptance_criteria,
        status: task.status,
        priority: task.priority,
        owner: task.owner,
        version: task.version,
      },
      checkpoint: checkpoint ? {
        id: checkpoint.id,
        task_version: checkpoint.task_version,
        progress_summary: checkpoint.progress_summary,
        completed_work: checkpoint.completed_work,
        current_findings: checkpoint.current_findings,
        unresolved_issues: checkpoint.unresolved_issues,
        next_steps: checkpoint.next_steps,
        file_references: checkpoint.file_references,
        created_at: checkpoint.created_at,
      } : null,
      decisions: allDecisions.map((d: any) => ({
        id: d.id,
        statement: d.statement,
        rationale: d.rationale,
        status: d.status,
        superseded_by: d.superseded_by,
        created_at: d.created_at,
      })),
      events: allEvents.map((e: any) => ({
        id: e.id,
        sequence: e.sequence,
        actor: e.actor,
        event_type: e.event_type,
        payload: e.payload,
        created_at: e.created_at,
      })),
    };

    return filterSecretsDeep(handoff);
  }
}
