export const OPERATOR = 'operator';

export type Actor = string;

export function isOperator(actor: string): boolean {
  return actor === OPERATOR;
}

/**
 * Agent IDs are self-declared as `<agent-string>_<project-id>` (root AGENTS.md)
 * and project ids never contain `_`, so the project id is the suffix after the
 * LAST underscore (agent strings may themselves contain `_`). Returns null when
 * the id carries no project suffix.
 */
export function projectIdFromAgentId(agentId: string): string | null {
  const idx = agentId.lastIndexOf('_');
  if (idx <= 0 || idx === agentId.length - 1) return null;
  return agentId.slice(idx + 1);
}
