import { z } from 'zod';

export const handoffJsonSchema = z.object({
  exported_at: z.string(),
  task: z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    objective: z.string().nullable(),
    acceptance_criteria: z.array(z.string()),
    status: z.string(),
    priority: z.string(),
    owner: z.string().nullable(),
  }),
  checkpoint: z.object({
    id: z.string(),
    progress_summary: z.string(),
    completed_work: z.string().nullable(),
    current_findings: z.string().nullable(),
    unresolved_issues: z.string().nullable(),
    next_steps: z.string().nullable(),
    file_references: z.array(z.string()),
    created_at: z.string(),
  }).nullable(),
  decisions: z.array(z.object({
    id: z.string(),
    statement: z.string(),
    rationale: z.string().nullable(),
    status: z.string(),
    superseded_by: z.string().nullable(),
    created_at: z.string(),
  })),
  events: z.array(z.object({
    id: z.string(),
    sequence: z.number().int(),
    actor: z.string(),
    event_type: z.string(),
    payload: z.record(z.unknown()),
    created_at: z.string(),
  })),
});
