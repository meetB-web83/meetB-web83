# AGENTS.md — WorkJournal Backend

## What this is

The backend is a pnpm monorepo containing four packages that implement the WorkJournal core service, MCP adapter, and CLI. The core service is the **only** process that owns SQLite access.

## Package layout

| Package | Purpose |
|---|---|
| `packages/shared` | Zod schemas, types, error catalog — single source of truth |
| `packages/core` | Fastify HTTP service with all business logic and DB access |
| `packages/mcp-adapter` | Thin stdio MCP server that forwards to core over HTTP |
| `packages/cli` | Management commands (start, stop, status, backup) |
| `tests` | Integration and E2E tests (Vitest + real SQLite) |

## Architecture invariants (do not break)

1. **Only `packages/core` opens SQLite.** The MCP adapter and dashboard talk to core over loopback HTTP. No exceptions.
2. **One transition function** in `core/src/domain/transitions.ts` is the only code path that mutates task status.
3. **Events are append-only** with a per-task monotonic sequence. Never update or delete events.
4. **Every state-changing operation** requires an idempotency key, enforces ownership and expected-version checks, and bumps the task version.
5. **Shared Zod schemas** in `packages/shared` are the single definition of inputs/outputs for API, MCP adapter, and dashboard.
6. **No authentication** (per root AGENTS.md override). Loopback binding, Zod validation, payload size limits, secret filtering on exports.
7. **Timestamps stored in UTC.** Only the dashboard converts to local time.
8. **Parameterized queries only** (Drizzle). No string concatenation in SQL.

## Development

```bash
# Install dependencies
pnpm install

# Run core service in dev mode
pnpm dev

# Run all tests
pnpm test

# Type-check all packages
pnpm typecheck

# Build all packages
pnpm build

# Start the MCP adapter (for AI agent integration)
pnpm mcp
```

## Environment

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Purpose |
|---|---|---|
| `WORKJOURNAL_HOME` | `~/.workjournal` | Root for registry + exports |
| `HOST` | `127.0.0.1` | Bind address (loopback only) |
| `PORT` | `3737` | Core service port |
| `LOG_LEVEL` | `info` | Pino log level |

## Testing

Tests use **real SQLite files in temp directories** — no mocks. Run with:

```bash
pnpm test
```

Test categories (per scope §18):
- State transitions (allowed + rejected)
- Concurrency and idempotency
- Continuity (Agent A → Agent B handoff)
- History and decisions
- Export (JSON + Markdown + secret filtering)
- Operations and security
- Backup and restore

## Key files to know

- `packages/shared/src/schemas/` — all Zod schemas (the contract)
- `packages/core/src/domain/transitions.ts` — the one transition function
- `packages/core/src/db/connection.ts` — SQLite open, WAL, FK, busy timeout
- `packages/core/src/http/server.ts` — Fastify app factory
- `packages/mcp-adapter/src/tools/` — MCP tool implementations (thin HTTP forwarders)
