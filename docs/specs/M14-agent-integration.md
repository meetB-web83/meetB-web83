# Spec — M14: Agent integration framework + `workjournal setup` (post-MVP)

Status: proposed
Date: 2026-10-23
Author: Mimo (agent)
Plan: docs/WorkJournal_post_MVP.md §2 (D-021, D-022), §10 (WS-9), §10.10, §10.11
Source of truth: this spec captures plan §10.2–§10.5 and D-021–D-023 verbatim where quoted; docs-only, no code. This file is explicitly named by the plan (`docs/specs/M14-agent-integration.md`).

## 1. Purpose

Pin the agent-integration contract (registry interface, discovery states, setup flow, OpenCode adapter, lifecycle plugin, ingestion integration) so WS-9 implements setup + plugin against a single reviewable reference. OpenCode is the only adapter in this release; adding another agent (e.g. Cline) is a new adapter file plus one registry entry.

## 2. Integration registry interface (plan §10.2)

`packages/cli/src/integrations/types.ts`:

```ts
interface AgentIntegration {
  id: string;                        // stable id, e.g. "opencode"
  displayName: string;
  supportedPlatforms: NodeJS.Platform[];
  capabilities: { mcp: boolean; lifecyclePlugin: boolean; hooks: string[] };
  discover(env: SetupEnv): Promise<DiscoveryResult>;   // installed? config paths? state
  plan(ctx: SetupContext): Promise<ConfigPlan>;         // pure — computes edits, no writes
  apply(plan: ConfigPlan): Promise<ApplyResult>;        // backup + atomic writes only
  validate(ctx: SetupContext): Promise<ValidateResult>; // post-write verification
  uninstall(ctx: SetupContext): Promise<ApplyResult>;   // removes ONLY managed entries
}
```

File layout (`packages/cli/src/integrations/`):

```
  types.ts                    — AgentIntegration + shared result types
  registry.ts                 — frozen [opencodeIntegration]
  setup.ts                    — command flow: flags, multiselect, summary report
  safe-config.ts              — agent-agnostic JSONC load/merge/backup/atomic-write
  adapters/opencode/
    discovery.ts              — OS paths, binary detection, state classification
    merge.ts                  — managed entry: mcp.servers.workjournal + auto-loaded plugin
    plugin.generated.ts       — committed embed output (D-011 pattern)
```

`capabilities` explicitly represents agents that support MCP but not lifecycle plugins (mcp-only agents skip the plugin install step).

## 3. DiscoveryResult states (plan §10.2)

Per integration: `not_installed` \| `installed_not_configured` \| `configured` \| `configuration_error` — each with evidence (paths checked, parse-error location).

## 4. Setup behavior (D-021, plan §10.3–§10.7)

- Setup logic lives behind `AgentIntegration`; the CLI iterates a **frozen registry array**. Adding another agent is a new adapter file plus one registry entry — no changes to the setup command flow.
- Interactive selection: zero-dependency `node:readline` numbered multiselect (CLI stays prompt-dep-free and SEA-safe).
- Config scope is **global by default** (`~/.config/opencode/opencode.json(c)`), with an explicit `--project` flag for repository-local config. Project scope resolves the nearest ancestor containing `.git` and edits `<repo-root>/opencode.json(c)` plus `<repo-root>/.opencode/plugins/`, matching OpenCode's own config discovery (verified with `opencode debug config`).
- OpenCode config files are JSONC: merges use Microsoft `jsonc-parser` minimal-edit operations so comments, formatting, and unrelated keys survive; the parser's duplicate-key limitation is documented and reported.
- Paths (platform-aware, no hardcoded single-OS path): Windows `%USERPROFILE%\.config\opencode\`; POSIX `$XDG_CONFIG_HOME/opencode/` else `~/.config/opencode/`; file `opencode.json` or `opencode.jsonc` (first existing wins; when none exists, create strict-JSON `opencode.json` at the global location).
- Binary detection via `opencode --version` (`where`/`command -v`).
- Parse before touching: jsonc-parser load; parse failure → `configuration_error`, original file untouched, error location reported.
- Minimal edits only: set `mcp.servers.workjournal` (`{ type: "local", command: [...] }`) and write the auto-loaded plugin to `<config>/plugins/workjournal.js`; all other keys, unknown keys, and comments survive. The legacy flat `mcp.workjournal` and the `plugins` array are migrated/removed for WorkJournal's own entries only — see D-024 for the verified Cline contract.
- Setup guarantees: timestamped backup before modifying an existing file; atomic write (temp file + rename in same directory); rollback on post-write validation failure; conflicting existing `workjournal` entry blocked without `--force`; identical managed values → no-op, differing → in-place minimal update; unparseable config → untouched + explained; uninstall removes managed entries only; per-file results — one failing integration never blocks another's report.

## 5. OpenCode lifecycle plugin (D-022, plan §10.2, §10.5)

- Small self-contained JS module authored in the repo, embedded into the SEA executable at build time (same generated-embed pattern as migrations and dashboard UI, D-011) and written to `~/.workjournal/integrations/opencode/plugin/` by `workjournal setup`.
- Default-exports `{ id, setup(ctx) }` — OpenCode V2 reads `id`/`setup` off the export, so no `@opencode/plugin` runtime dependency is needed in the extracted location (tiny embedded `Plugin.define` shim as fallback, verified by spike).
- Observes only reliably observable signals (session lifecycle, interruption, idle, errors) via `ctx.event.subscribe()` and optional tool hooks; POSTs canonical envelopes to Core `POST /api/ingest/events` (see M10).
- Delivery: bounded queue in `ctx.storage` with backoff when Core is down; the plugin **never autostarts Core** (the MCP adapter's D-013 autostart covers agent work sessions).
- Cline records one `agent_tool_call` per completed tool call (default on, D-027) and attaches a run summary to `agent_session_ended`; the recorded target is the tool's first file path / command / query after secret redaction and truncation. OpenCode tool capture stays unimplemented until its event surface is verified against the installed build.
- Idle/errors/interruption are recorded as signals, never as proof of task completion.

## 6. Ingestion integration (plan §10.5, §10.11; see M10)

Plugin events arrive at Core as canonical envelopes via `POST /api/ingest/events`; envelopes are restricted to ledger categories and cannot mutate task status. Nullable `task_id` (§3.1/M3) is required for project-level plugin events; the MCP adapter forwards `_meta["ai.opencode/sessionID"]` with tool calls for session↔task correlation. Dashboard/WS-3 shows plugin-sourced events in the unified timeline via the `source` field with no extra UI work.

## 7. Adding future agents (plan §10.10)

Implement `AgentIntegration` (discovery rules, merge logic for that agent's config format, validation), declare `capabilities`, register in `registry.ts`, add an ingestion `source` mapping if the agent has a lifecycle plugin mechanism, and add adapter fixtures to the integration suite. The canonical event schema and ingestion API stay agent-independent — adapters translate native events into the shared envelope; no setup-CLI or event-model changes required. (A "fake agent" fixture adapter proves a second integration flows through setup without code changes.)

## 8. Verification (docs-only)

- Interface, file layout, DiscoveryResult states, setup guarantees, plugin export shape, and ingestion wiring trace to plan §10.2–§10.5 and D-021–D-023.
- No new runtime deps beyond `jsonc-parser`; no new transport, no CLI behavior change beyond additive `setup` subcommand (plan §10.1).
- git diff for this session contains `docs/specs/*` only.

## 9. Amendment — verified config schemas (2026-10-27, D-024)

§4's `plugins` array and the assumed Cline path were placeholders written before the agents' installed formats were checked. The implementation now targets:

- **OpenCode:** `mcp.servers.workjournal = { type: "local", command: [...] }` (verified with `opencode mcp add`); plugins auto-load from `<config>/plugins/` or `<project>/.opencode/plugins/`. The flat `mcp.workjournal` shape is treated as legacy and migrated.
- **Cline:** `~/.cline/data/settings/cline_mcp_settings.json` → `mcpServers.workjournal = { command, args, disabled, autoApprove }`; ESM extension package under `~/.cline/plugins/workjournal/` or `<project>/.cline/plugins/workjournal/`.

The lifecycle plugin is installed only in the global scope. Plugins scope events by the session workspace, so one global copy covers every project; a project copy would report each session twice. `--project` edits config only and warns when no global plugin is installed.

Setup exits non-zero on `not_installed`, `configuration_error`, refused plans, write failure, or validation failure; success is printed only after validation passes. See D-024 for the full policy.

## 10. Amendment — project resolution and delivery (2026-10-27, D-026)

§5 says events are "project-scoped" but does not pin how a workspace maps to a registered project. The implementation now does:

- **Canonical path comparison.** Both plugins compare the session workspace with each registered `root_path` after canonicalizing: git-bash `/c/Users/...` and WSL `/mnt/c/Users/...` become `c:/Users/...`, backslashes become forward slashes, trailing slashes are dropped, and Windows paths are case-folded. This mirrors Core's `normalizeRootPath`; a registry row created through a POSIX-shell path previously never matched the agent's native path, so every event was dropped without an error.
- **Failures are reported.** An unmatched workspace is logged once per session with the directory and the registered roots (through the host logger for Cline, `console.warn` for OpenCode) instead of being discarded silently.
- **Retry while the session lives.** A failed delivery (Core unreachable, 5xx) re-arms a timer instead of waiting for the next event, so a short Core outage no longer loses the tail of a session; the queue is also flushed once on teardown.
- **Session dedupe.** Cline's `run-started`/`run-finished` fire per run and per sub-agent; one `agent_session_started` and one `agent_session_ended` are emitted per `conversationId`.

Cline hook names were verified against `@cline/shared` (`AgentRuntimeHooks`: `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`) and the CLI's plugin loader (`resolveAndLoadAgentPlugins`, worker execution, static `hooks` on the extension object). No change to the setup flow or the envelope schema.

## 11. Amendment — per-tool activity (2026-10-27, D-027)

Session start/end alone is only a heartbeat. The Cline plugin (v3) now emits activity rows:

- **`agent_tool_call`** — one row per completed tool call (category `agent`, ingestible). Payload: `agent_id`, `session_id`, `tool`, `status: succeeded | failed`, `duration_ms`, optional `target`, optional `tool_call_id`. `target` is the first recognizable file path / command / query in the tool input, secret-redacted with the same credential shapes as Core's export filter and truncated to 1024 chars. Raw tool inputs and outputs are never sent.
- **Run summary** — `agent_session_ended` gains optional `duration_ms`, `iterations`, `tool_call_count`, `failed_tool_call_count`, `files_touched` (≤ 100, write-like tools only), `input_tokens`, `output_tokens`. All optional, so plugins older than v3 remain valid.
- **Delivery** — the Cline queue bound rises to 500 rows so a long run does not drop the head of its activity trail.
- **Scope** — tool rows carry `session_id`, so Core's existing binding backfill attaches them to the claimed task when a binding exists; otherwise they stay project-level.

OpenCode is unchanged: its plugin surface must be verified before it can emit tool rows, and this amendment does not guess at it.
