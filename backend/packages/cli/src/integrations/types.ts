/**
 * Agent integration framework (plan §10.2, decision D-021, spec M14).
 *
 * The `AgentIntegration` interface abstracts per-agent setup (discovery,
 * plan, apply, validate, uninstall). The CLI iterates a frozen registry array,
 * so adding another agent is a new adapter file plus one registry entry — no
 * changes to the setup command flow.
 */

export type NodePlatform = 'win32' | 'darwin' | 'linux';

export interface SetupEnv {
  /** Current working directory of the CLI invocation. */
  cwd: string;
  /** Platform the CLI is running on. */
  platform: NodePlatform;
  /** WorkJournal home directory (~/.workjournal by default). */
  workjournalHome: string;
  /** OS home directory override. Defaults to os.homedir(); tests set this. */
  homeDir?: string;
  /** Config scope to inspect. Defaults to global. */
  scope?: 'global' | 'project';
}

export interface SetupContext extends SetupEnv {
  /** Selected agent integration id (e.g. "opencode"). */
  agentId: string;
  /** Config scope: 'global' (default) or 'project'. */
  scope: 'global' | 'project';
  /** Whether to skip prompts and apply automatically. */
  yes: boolean;
  /** Whether to overwrite conflicting managed entries. */
  force: boolean;
  /** Dry run: print planned changes without writing. */
  dryRun: boolean;
}

export interface DiscoveryResult {
  /** Agent id. */
  id: string;
  /** One of: not_installed | installed_not_configured | configured | configuration_error. */
  state: 'not_installed' | 'installed_not_configured' | 'configured' | 'configuration_error';
  /** Human-readable evidence for the state. */
  evidence: string[];
  /** Paths that were checked during discovery. */
  paths: string[];
  /** Parse error location, if state is configuration_error. */
  parseError?: { file: string; message: string };
}

export interface PlannedFile {
  path: string;
  action: 'create' | 'update' | 'noop';
  /** Exact content to write. Absent only for noop entries. */
  content?: string;
}

export interface ConfigPlan {
  agentId: string;
  scope: 'global' | 'project';
  /** Files that would be created or modified, with the intended content. */
  files: PlannedFile[];
  /** Managed entries that would be set (for reporting/preview). */
  managedEntries: Array<{ file: string; key: string; value: string }>;
  /**
   * Set when the plan cannot be applied (unparseable config, conflicting
   * entry without --force). The setup command reports this and writes nothing.
   */
  error?: string;
  /** Non-fatal notes shown after the planned changes. */
  warnings?: string[];
}

export interface ApplyResult {
  agentId: string;
  success: boolean;
  filesModified: string[];
  error?: string;
  /** Backups created before modifying existing files. */
  backups?: string[];
}

export interface ValidateResult {
  agentId: string;
  valid: boolean;
  details: string[];
}

export interface AgentIntegration {
  id: string;
  displayName: string;
  supportedPlatforms: NodePlatform[];
  capabilities: {
    mcp: boolean;
    lifecyclePlugin: boolean;
    hooks: string[];
  };
  discover(env: SetupEnv): Promise<DiscoveryResult>;
  plan(ctx: SetupContext): Promise<ConfigPlan>;
  apply(plan: ConfigPlan, ctx: SetupContext): Promise<ApplyResult>;
  validate(ctx: SetupContext): Promise<ValidateResult>;
  uninstall(ctx: SetupContext): Promise<ApplyResult>;
}
