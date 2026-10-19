# 01 — WorkJournal Project Overview

## The one-sentence version

**WorkJournal preserves task progress across AI coding-agent sessions, so one
agent can stop and another can resume — without losing context.**

## The problem it solves

AI coding assistants (Muse Spark, Cline, Claude, etc.) work in sessions. When a
session ends — context window fills, the developer switches tools, the laptop
sleeps — everything the agent knew about *what it was doing and why* evaporates.
The next agent starts from the raw code and the chat transcript, re-derives the
plan, and often repeats or contradicts earlier work.

WorkJournal is the persistent memory layer for that handoff: tasks with explicit
status, progress checkpoints, recorded decisions with rationale, and
deterministic "resume here" briefs — all stored locally, all inspectable.

## Who it's for

| Audience | How they use it |
|----------|-----------------|
| **AI coding agents** (primary) | Create/claim tasks, record checkpoints and decisions, export handoffs — via the MCP adapter (stdio) |
| **meetb** (the developer) | Watch progress, review decisions, recover stuck tasks — via the dashboard |
| **A PM/reviewer** (you) | Verify scope, run it locally, click through the dashboard, check the review checklist |

## What it is — and isn't

| It IS | It is NOT (Release 1) |
|-------|----------------------|
| A local-first task continuity system | A team collaboration tool (no multi-user, no login) |
| A dashboard for humans + an MCP API for agents | A hosted SaaS product (no cloud, no accounts) |
| Deterministic and inspectable (SQLite files you can open) | An AI product (no LLM inside — it stores what agents write, verbatim) |
| A single-repo monorepo (backend + frontend) | A finished product (MVP Release 1 scope; see below) |

## Current state (as of 2026-10-16)

**Working and verified:**

- Task lifecycle: create → claim → progress/block/complete, with ownership and
  version checks on every write (36 backend tests green).
- Continuity records: checkpoints, decisions (with supersede history),
  append-only event log, deterministic resume context and JSON/Markdown handoff
  export.
- Dashboard: home (stats, scope picker, recents), projects, task detail with
  history, resume view, API reference — Neo-Brutalist design system.
- Project registration with a **server-side folder picker** (Browse returns real
  full paths) and scope-independent project counts.
- MCP adapter: ~19 tools over stdio, schema-shared with the HTTP API.

**Recently completed workstreams** (see the dashboard's own task list):

- Neo-Digital Brutalism design system across the frontend.
- Dashboard API (`GET /api/dashboard`) with stats, recents, project scope.
- Scope picker moved into the top nav, bound to shareable `?scope=`.
- Server-side folder browser (`GET /api/projects/browse`).
- Scope-independent project count fix.

**Deliberately out of Release 1 scope:** authentication (loopback-only instead),
auto-starting the service, cloud sync, multi-user, jump-to-page pagination
(limit+1 "next" only), paginating the tiny projects/decisions tables.

## Key concepts (30-second glossary)

- **Project** — a registered folder. Each has its own SQLite DB under
  `<root>/.workjournal/`. The global registry (`~/.workjournal/registry.db`) is
  just an index of projects.
- **Task** — a unit of work with status (`open → in_progress → completed`, plus
  `blocked`/`interrupted`/`cancelled`), an owner agent, and a version number.
- **Checkpoint** — "here's where I am" note pinned to a task version.
- **Decision** — a choice + its rationale + rejected alternatives. Superseding
  keeps the old record; nothing is rewritten.
- **Event log** — append-only, per-task, monotonic. The audit trail.
- **Resume context** — a deterministic brief for the next agent: same records →
  same brief, every time.
- **Idempotency key** — every write carries one; retrying the identical call
  returns the stored response instead of duplicating work.
- **Agent ID** — self-declared `<agent-string>_<project-id>` (e.g.
  `cline_e405de72-…`). The dashboard's `operator` actor is reserved for human
  actions.

## Where to look next

- To **run it**: `02-how-to-run.md`
- To **click through it**: `03-how-to-navigate.md`
- To **understand the agent wiring**: `04-mcp-for-agents.md`
- To **understand the internals**: `05-architecture-and-data.md`
- To **sign off**: `06-review-checklist.md`
