import type { Database } from '../db/connection.js';
import { TaskService } from '../domain/task-service.js';
import { ProjectService } from '../domain/project-service.js';
import { CheckpointService } from '../domain/checkpoint-service.js';
import { DecisionService } from '../domain/decision-service.js';
import { EventService } from '../domain/event-service.js';
import { ResumeBuilder } from '../resume/resume-builder.js';
import { JsonExporter } from '../export/json-export.js';
import { MarkdownExporter } from '../export/markdown-export.js';
import type { Services } from '../domain/services.js';

export type CoreServices = Services;

/** Build a service bundle bound to one database (the registry, or one project DB). */
export function buildServices(db: Database): Services {
  return {
    tasks: new TaskService(db),
    projects: new ProjectService(db),
    checkpoints: new CheckpointService(db),
    decisions: new DecisionService(db),
    events: new EventService(db),
    resume: new ResumeBuilder(db),
    jsonExport: new JsonExporter(db),
    markdownExport: new MarkdownExporter(db),
  };
}
