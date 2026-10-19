import type { TaskService } from './task-service.js';
import type { ProjectService } from './project-service.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { DecisionService } from './decision-service.js';
import type { EventService } from './event-service.js';
import type { ResumeBuilder } from '../resume/resume-builder.js';
import type { JsonExporter } from '../export/json-export.js';
import type { MarkdownExporter } from '../export/markdown-export.js';

/** Service bundle bound to one database (the registry, or one project DB). */
export interface Services {
  tasks: TaskService;
  projects: ProjectService;
  checkpoints: CheckpointService;
  decisions: DecisionService;
  events: EventService;
  resume: ResumeBuilder;
  jsonExport: JsonExporter;
  markdownExport: MarkdownExporter;
}
