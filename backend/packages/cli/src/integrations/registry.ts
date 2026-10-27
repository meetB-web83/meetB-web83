/**
 * Agent integration registry (plan §10.2, decision D-021).
 *
 * Frozen array of all supported agent integrations. Adding another agent
 * (e.g. Cline) is a new adapter file plus one entry here — no changes to
 * the setup command flow.
 *
 * OpenCode is the only adapter in this release; Cline is added as a second
 * adapter per the symmetrical adapter layout.
 */

import type { AgentIntegration } from './types.js';
import { opencodeIntegration } from './adapters/opencode/index.js';
import { clineIntegration } from './adapters/cline/index.js';

/** Frozen registry — order determines setup presentation. */
export const AGENT_INTEGRATIONS: readonly AgentIntegration[] = Object.freeze([
  opencodeIntegration,
  clineIntegration,
]);

export function findIntegration(id: string): AgentIntegration | undefined {
  return AGENT_INTEGRATIONS.find((i) => i.id === id);
}
