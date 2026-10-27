# WorkJournal

A local-first task-continuity system for AI coding agents: one agent can stop a task, and another can resume it from stored records — progress checkpoints,
decisions, and append-only event history — without the original conversation.

## What's in the box

| Piece | What it does |
|---|---|
| **Core service** (`backend/packages/core`) | Fastify HTTP API; the only process that touches SQLite (registry + per-project DBs, `node:sqlite`) |
| **MCP adapter** (`backend/packages/mcp-adapter`) | Exposes the WorkJournal tools to AI agents — stdio for native dev, Streamable HTTP (`/mcp`) for Docker/remote clients |
| **Dashboard** (`frontend`) | React + Vite, SPA: projects, tasks, history, resume context |
| **CLI** (`backend/packages/cli`) | start / stop / status / backup |

## Quick start — Docker

Download `compose.yaml` from the [latest release](../../releases) and run:

```bash
docker compose up -d
```

- Dashboard: <http://127.0.0.1:3000>
- MCP endpoint: <http://127.0.0.1:3738/mcp> (Streamable HTTP)

Full guide — client setup (OpenCode, Cline), backups, upgrades, configuration,
security model: **[docs/DOCKER.md](docs/DOCKER.md)**.

## Quick start — native development

```bash
cd backend && pnpm install
pnpm dev                     # core service (127.0.0.1:3737)
pnpm mcp                     # MCP adapter over stdio
pnpm test                    # Vitest, real SQLite in temp dirs

cd ../frontend && pnpm install
pnpm dev                     # dashboard (127.0.0.1:5173, proxies /api to core)
```

**Self-starting MCP (D-013):** the SEA executable's `workjournal mcp` probes
the core and starts it itself when it is down — add `--with-ui` to serve the
dashboard on the same port (`--no-autostart` keeps the old error behaviour).
If a core is already running **without** the dashboard, `mcp --with-ui` stops
it and starts a replacement that serves the UI (D-014); `--no-autostart`
keeps the old attach-and-note behaviour there too.
A service started this way stops itself 5 minutes after the last MCP client
disconnects (last one out); services you start by hand only stop via
`workjournal stop`, and Docker is unaffected. Source runs (`pnpm mcp`) autostart
only when `MCP_AUTOSTART_ENTRY` points at the built CLI entry.

## Repository layout

```
backend/               pnpm workspace: shared (Zod contract), core, mcp-adapter, cli, tests
frontend/              React + Vite dashboard
docs/                  scope, specs, decisions, Docker guide, release artifacts
docker-compose.yml     from-source Compose bundle (builds local :dev images)
.github/workflows/     release pipeline (verify → build → push → publish compose.yaml)
```

## Architecture rules (abridged — see `AGENTS.md` files)

- Only the core service opens SQLite; the adapter and dashboard talk to it over
  loopback/Compose-network HTTP.
- One transition function validates every task status change; events are
  append-only; every write requires an idempotency key, ownership and
  expected-version checks.
- Shared Zod schemas are the single input/output contract for API, MCP and UI.
- No authentication in Release 1 — loopback binding, header validation and
  (for the HTTP MCP endpoint) an optional bearer token are the protections.

## Contributing to the codebase

Read `AGENTS.md` (root), `backend/AGENTS.md` and `frontend/AGENTS.md` first.
Design decisions live in `docs/decisions.md`; scope in `docs/mvp-scope.md`.
