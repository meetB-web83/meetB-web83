/**
 * SQLite stores JSON columns as TEXT; the shared response schemas promise parsed values
 * (`acceptance_criteria: z.array(string)`, `payload: z.record(...)` etc.). Every read path
 * maps rows through these helpers so the wire format matches the contract — the dashboard
 * and MCP clients must never see JSON text. Parsing is idempotent: an already-parsed
 * value passes through unchanged.
 */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
}

export function toTaskRow<T extends Record<string, any>>(row: T) {
  return { ...row, acceptance_criteria: parseJsonColumn<string[]>(row.acceptance_criteria, []) };
}

export function toEventRow<T extends Record<string, any>>(row: T) {
  return { ...row, payload: parseJsonColumn<Record<string, unknown>>(row.payload, {}) };
}

export function toCheckpointRow<T extends Record<string, any>>(row: T) {
  return { ...row, file_references: parseJsonColumn<string[]>(row.file_references, []) };
}

export function toDecisionRow<T extends Record<string, any>>(row: T) {
  return {
    ...row,
    alternatives: parseJsonColumn<string[]>(row.alternatives, []),
    supporting_event_ids: parseJsonColumn<string[]>(row.supporting_event_ids, []),
  };
}
