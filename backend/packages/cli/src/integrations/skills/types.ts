/**
 * WorkJournal Skills types (Addendum A).
 *
 * Skills are reusable instructions/guides that WorkJournal installs into
 * each agent's global skills directory so agents know how to work with
 * WorkJournal effectively without the user explaining every time.
 */

export interface Skill {
  /** Unique skill identifier (e.g., "session-start", "task-workflow"). */
  id: string;

  /** Human-readable name. */
  name: string;

  /** Brief description shown in summaries. */
  description: string;

  /** Skill content in Markdown format. */
  content: string;

  /** Target filename (without extension) for this skill. */
  filename: string;
}

/** Per-agent skill target configuration. */
export interface AgentSkillTarget {
  /** Agent integration ID (e.g., "opencode", "cline"). */
  agentId: string;

  /** Global skills directory for this agent. */
  globalSkillsDir: string;

  /** File extension for skills (e.g., ".md", ".mdc"). */
  extension: string;

  /** Whether this was a fallback directory (for Antigravity). */
  isFallback: boolean;
}

/** Result of skills installation for one agent. */
export interface SkillsInstallResult {
  agentId: string;
  agentDisplayName: string;
  success: boolean;
  skillsInstalled: Array<{ skillId: string; path: string }>;
  skillsSkipped: Array<{ skillId: string; reason: string }>;
  error?: string;
  workjournalMirrorPath: string;
}

/** Overall skills installation summary. */
export interface SkillsInstallSummary {
  totalAgents: number;
  successfulAgents: number;
  failedAgents: number;
  results: SkillsInstallResult[];
}