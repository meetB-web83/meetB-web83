import { v4 as uuid } from 'uuid';
import type { Database } from '../db/connection.js';
import { IdempotencyService, type IdempotencyOptions } from './idempotency-service.js';
import { NotFoundError, BuiltinPromptProtectedError, StaleVersionError } from '@workjournal/shared';

export type MutationIdempotency = Pick<IdempotencyOptions, 'key' | 'input'>;

export interface CreatePromptData {
  name: string;
  description?: string;
  category?: string;
  template: string;
  args?: any[];
  projectId?: string | null;
  idempotency?: MutationIdempotency;
}

export interface UpdatePromptData {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  template?: string;
  args?: any[];
  enabled?: boolean;
  expectedVersion: number;
  idempotency?: MutationIdempotency;
}

export class PromptService {
  private idem: IdempotencyService;
  constructor(private db: Database) {
    this.idem = new IdempotencyService(db);
  }

  private rowToPrompt(row: any) {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      category: row.category,
      template: row.template,
      arguments: JSON.parse(row.arguments || '[]'),
      project_id: row.project_id ?? null,
      is_builtin: !!row.is_builtin,
      enabled: !!row.enabled,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  list(opts: { scope?: 'global' | 'project'; projectId?: string; category?: string; enabled?: boolean; includeBuiltin?: boolean; resolved?: boolean }) {
    if (opts.resolved && opts.projectId) {
      const rows = this.db.raw.prepare('SELECT * FROM prompts WHERE project_id = ? OR project_id IS NULL').all(opts.projectId) as any[];
      const byName = new Map<string, any>();
      for (const r of rows) {
        if (opts.category && r.category !== opts.category) continue;
        if (opts.enabled !== undefined && !!r.enabled !== opts.enabled) continue;
        const existing = byName.get(r.name);
        if (!existing) byName.set(r.name, r);
        else if (r.project_id && !existing.project_id) byName.set(r.name, r);
      }
      const result: any[] = [];
      for (const [, r] of byName) {
        if (!r.enabled) continue;
        result.push(this.rowToPrompt(r));
      }
      return result;
    }
    let sql = 'SELECT * FROM prompts WHERE 1=1';
    const params: any[] = [];
    if (opts.scope === 'global') { sql += ' AND project_id IS NULL'; }
    if (opts.scope === 'project' && opts.projectId) { sql += ' AND project_id = ?'; params.push(opts.projectId); }
    if (opts.category) { sql += ' AND category = ?'; params.push(opts.category); }
    if (opts.enabled !== undefined) { sql += ' AND enabled = ?'; params.push(opts.enabled ? 1 : 0); }
    if (opts.includeBuiltin === false) { sql += ' AND is_builtin = 0'; }
    sql += ' ORDER BY name ASC, created_at ASC';
    return (this.db.raw.prepare(sql).all(...params) as any[]).map((r) => this.rowToPrompt(r));
  }

  get(id: string) {
    const row = this.db.raw.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as any;
    if (!row) throw new NotFoundError(`Prompt ${id} not found`);
    return this.rowToPrompt(row);
  }

  async toggle(id: string, enabled: boolean, expectedVersion: number, idempotency?: MutationIdempotency) {
    return this.update({ id, enabled, expectedVersion, idempotency });
  }

  async create(data: CreatePromptData) {
    return this.idem.run(
      'registry_idempotency' as any,
      data.idempotency && { ...data.idempotency, operation: 'prompt.create', actor: 'operator' },
      () => {
        const id = uuid();
        const now = new Date().toISOString();
        const category = data.category || 'custom';
        this.db.raw.prepare(
          `INSERT INTO prompts (id, name, description, category, template, arguments, project_id, is_builtin, enabled, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
        ).run(id, data.name, data.description ?? null, category, data.template, JSON.stringify(data.args || []), data.projectId ?? null, now, now);
        return this.get(id);
      },
    );
  }

  async update(data: UpdatePromptData) {
    return this.idem.run(
      'registry_idempotency' as any,
      data.idempotency && { ...data.idempotency, operation: 'prompt.update', actor: 'operator' },
      () => {
        const existing = this.get(data.id);
        if (existing.version !== data.expectedVersion) {
          throw new StaleVersionError(`Prompt ${data.id} version mismatch`);
        }
        const now = new Date().toISOString();
        const fields: string[] = [];
        const params: any[] = [];
        if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
        if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
        if (data.category !== undefined) { fields.push('category = ?'); params.push(data.category); }
        if (data.template !== undefined) { fields.push('template = ?'); params.push(data.template); }
        if (data.args !== undefined) { fields.push('arguments = ?'); params.push(JSON.stringify(data.args)); }
        if (data.enabled !== undefined) { fields.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
        fields.push('version = version + 1');
        fields.push('updated_at = ?');
        params.push(now);
        params.push(data.id);
        this.db.raw.prepare(`UPDATE prompts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        return this.get(data.id);
      },
    );
  }

  async remove(id: string) {
    const p = this.get(id);
    if (p.is_builtin) throw new BuiltinPromptProtectedError(`Prompt ${id} is built-in and cannot be deleted`);
    this.db.raw.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  preview(id: string, args: Record<string, any> = {}) {
    const p = this.get(id);
    let out = p.template;
    for (const [k, v] of Object.entries(args)) {
      out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
    }
    return { rendered: out };
  }
}