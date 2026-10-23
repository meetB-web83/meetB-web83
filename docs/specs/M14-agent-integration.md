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
    merge.ts                  — managed entries: mcp.servers.workjournal + plugins
    plugin/index.js           — lifecycle plugin source (embedded at build time)
    plugin.generated.ts       — committed embed output (D-011 pattern)
```

`capabilities` explicitly represents agents that support MCP but not lifecycle plugins (mcp-only agents skip the plugin install step).

## 3. DiscoveryResult states (plan §10.2)

Per integration: `not_installed` \| `installed_not_configured` \| `configured` \| `configuration_error` — each with evidence (paths checked, parse-error location).

## 4. Setup behavior (D-021, plan §10.3–§10.7)

- Setup logic lives behind `AgentIntegration`; the CLI iterates a **frozen registry array**. Adding another agent is a new adapter file plus one registry entry — no changes to the setup command flow.
- Interactive selection: zero-dependency `node:readline` numbered multiselect (CLI stays prompt-dep-free and SEA-safe).
- Config scope is **global by default** (`~/.config/opencode/opencode.json(c)`), with an explicit `--project` flag for cwd-local config.
- OpenCode config files are JSONC: merges use Microsoft `jsonc-parser` minimal-edit operations so comments, formatting, and unrelated keys survive; the parser's duplicate-key limitation is documented and reported.
- Paths (platform-aware, no hardcoded single-OS path): Windows `%USERPROFILE%\.config\opencode\`; POSIX `$XDG_CONFIG_HOME/opencode/` else `~/.config/opencode/`; file `opencode.json` or `opencode.jsonc` (first existing wins; when none exists, create strict-JSON `opencode.json` at the global location).
- Binary detection via `opencode --version` (`where`/`command -v`).
- Parse before touching: jsonc-parser load; parse failure → `configuration_error`, original file untouched, error location reported.
- Minimal edits only: set `mcp.servers.workjournal` and append the plugin path to `plugins` (matched by `~/.workjournal/integrations` prefix); all other keys, unknown keys, and comments survive.
- Setup guarantees: timestamped backup before modifying an existing file; atomic write (temp file + rename in same directory); rollback on post-write validation failure; conflicting existing `workjournal` entry blocked without `--force`; identical managed values → no-op, differing → in-place minimal update; unparseable config → untouched + explained; uninstall removes managed entries only; per-file results — one failing integration never blocks another's report.

## 5. OpenCode lifecycle plugin (D-022, plan §10.2, §10.5)

- Small self-contained JS module authored in the repo, embedded into the SEA executable at build time (same generated-embed pattern as migrations and dashboard UI, D-011) and written to `~/.workjournal/integrations/opencode/plugin/` by `workjournal setup`.
- Default-exports `{ id, setup(ctx) }` — OpenCode V2 reads `id`/`setup` off the export, so no `@opencode/plugin` runtime dependency is needed in the extracted location (tiny embedded `Plugin.define` shim as fallback, verified by spike).
- Observes only reliably observable signals (session lifecycle, interruption, idle, errors) via `ctx.event.subscribe()` and optional tool hooks; POSTs canonical envelopes to Core `POST /api/ingest/events` (see M10).
- Delivery: bounded queue in `ctx.storage` with backoff when Core is down; the plugin **never autostarts Core** (the MCP adapter's D-013 autostart covers agent work sessions).
- Low-level tool-call logging is opt-in via plugin options, **default off** (D-022: `agent_tool_call` logging default off, opt-in via plugin option).
- Idle/errors/interruption are recorded as signals, never as proof of task completion.

## 6. Ingestion integration (plan §10.5, §10.11; see M10)

Plugin events arrive at Core as canonical envelopes via `POST /api/ingest/events`; envelopes are restricted to ledger categories and cannot mutate task status. Nullable `task_id` (§3.1/M3) is required for project-level plugin events; the MCP adapter forwards `_meta["ai.opencode/sessionID"]` with tool calls for session↔task correlation. Dashboard/WS-3 shows plugin-sourced events in the unified timeline via the `source` field with no extra UI work.

## 7. Adding future agents (plan §10.10)

Implement `AgentIntegration` (discovery rules, merge logic for that agent's config format, validation), declare `capabilities`, register in `registry.ts`, add an ingestion `source` mapping if the agent has a lifecycle plugin mechanism, and add adapter fixtures to the integration suite. The canonical event schema and ingestion API stay agent-independent — adapters translate native events into the shared envelope; no setup-CLI or event-model changes required. (A "fake agent" fixture adapter proves a second integration flows through setup without code changes.)

## 8. Verification (docs-only)

- Interface, file layout, DiscoveryResult states, setup guarantees, plugin export shape, and ingestion wiring trace to plan §10.2–§10.5 and D-021–D-023.
- No new runtime deps beyond `jsonc-parser`; no new transport, no CLI behavior change beyond additive `setup` subcommand (plan §10.1).
- git diff for this session contains `docs/specs/*` only.