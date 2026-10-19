import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';
import { queryBoolean } from './query.js';

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  root_path: z.string().min(1).max(1024),
  idempotency_key: idempotencyKeySchema,
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  idempotency_key: idempotencyKeySchema,
});

export const projectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  root_path: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const listProjectsQuerySchema = z.object({
  available: queryBoolean.optional(),
});

/**
 * Directory browser for the dashboard folder picker (Option A follow-up).
 * `path` absent/empty means filesystem roots (drive letters on Windows, `/` on
 * posix). `search` filters entry names case-insensitively. Read-only.
 */
export const browseDirectoriesQuerySchema = z.object({
  path: z.string().max(1024).optional(),
  search: z.string().max(200).optional(),
});

export const browseDirectoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  has_workjournal: z.boolean(),
});

export const browseDirectoriesResponseSchema = z.object({
  current_path: z.string().nullable(),
  parent_path: z.string().nullable(),
  entries: z.array(browseDirectoryEntrySchema),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type BrowseDirectoriesQuery = z.infer<typeof browseDirectoriesQuerySchema>;
export type BrowseDirectoryEntry = z.infer<typeof browseDirectoryEntrySchema>;
export type BrowseDirectoriesResponse = z.infer<typeof browseDirectoriesResponseSchema>;
