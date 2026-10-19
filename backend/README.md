# WorkJournal Backend

Local-first task continuity system — backend monorepo.

## Quick start

```bash
# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env

# Start the core service
pnpm start

# Run tests
pnpm test

# Start the MCP adapter (for AI agent integration)
pnpm mcp
```

## Architecture

```
backend/
├── packages/
│   ├── shared/          # Zod schemas, types, errors (single source of truth)
│   ├── core/            # Fastify HTTP service — owns all DB access
│   ├── mcp-adapter/     # Thin stdio MCP server → HTTP forwarder
│   └── cli/             # Management commands (start/stop/status/backup)
└── tests/               # Vitest integration + E2E tests
```

**Invariant:** Only `packages/core` opens SQLite. All other packages talk to it over loopback HTTP.

## Packages

| Package | Purpose |
|---|---|
| `@workjournal/shared` | Zod schemas, types, error catalog |
| `@workjournal/core` | Fastify service with all business logic |
| `@workjournal/mcp-adapter` | MCP stdio adapter → HTTP forwarder |
| `@workjournal/cli` | CLI for service management |

## API

Base URL: `http://127.0.0.1:3737`

| Endpoint | Description |
|---|---|
| `POST /api/projects` | Create project |
| `GET /api/projects` | List projects |
| `POST /api/tasks` | Create task |
| `GET /api/tasks` | List tasks (filter by project, status, priority) |
| `GET /api/tasks/:id` | Get task |
| `PATCH /api/tasks/:id` | Update task |
| `POST /api/tasks/:id/claim` | Claim task |
| `POST /api/tasks/:id/release` | Release task |
| `POST /api/tasks/:id/transition` | Transition task status |
| `GET /api/events` | List task events |
| `POST /api/checkpoints` | Record checkpoint |
| `GET /api/checkpoints` | List checkpoints |
| `POST /api/decisions` | Record decision |
| `GET /api/decisions` | List decisions |
| `POST /api/decisions/:id/supersede` | Supersede decision |
| `GET /api/resume` | Get resume context |
| `GET /api/export/json` | Export JSON handoff |
| `GET /api/export/markdown` | Export HANDOFF.md |

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `WORKJOURNAL_HOME` | `~/.workjournal` | Root for registry + exports |
| `HOST` | `127.0.0.1` | Bind address (loopback only) |
| `PORT` | `3737` | Core service port |
| `LOG_LEVEL` | `info` | Pino log level |

## Testing

Tests use real SQLite files in temp directories — no mocks.

```bash
pnpm test
```

## License

Private — meetb
