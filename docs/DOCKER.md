# Running WorkJournal with Docker

WorkJournal ships as three containers — dashboard (`web`), core service (`core`),
and the MCP Streamable HTTP endpoint (`mcp`) — plus a named volume for SQLite.
The core service is the only process that touches the database; the dashboard and
the MCP adapter talk to it over the internal Compose network.

```
host browser ──127.0.0.1:3000──▶ web (vite preview) ──http://core:3737──▶ core ──▶ SQLite volume
MCP client  ──127.0.0.1:3738/mcp──▶ mcp (Streamable HTTP) ──http://core:3737──▶ core ──▶ SQLite volume
```

## Quick start (no source checkout)

1. Install Docker (Docker Desktop or Docker Engine with the Compose plugin).
2. Download `compose.yaml` from the [latest GitHub release](../../releases).
3. Open a terminal in the download directory.
4. Start everything:

   ```bash
   docker compose up -d
   ```

5. Open the dashboard: <http://127.0.0.1:3000>
6. Point your MCP client at <http://127.0.0.1:3738/mcp> (see below).

Images are pulled from the registry referenced in the release's `compose.yaml` —
nothing is built locally.

## Service status and logs

```bash
docker compose ps                    # health status of all services
docker compose logs -f core          # or: mcp, web
```

Health endpoints: core serves `GET /health` on its internal port; the MCP server
serves `GET /healthz` (both return `{"status":"ok"}`). `docker compose ps` shows
`healthy` only after these respond — a started container is not assumed ready.

## Connecting an MCP client

The endpoint is **<http://127.0.0.1:3738/mcp>** (Streamable HTTP). It must be
running before the client connects; after a container restart, reconnect the
client (sessions do not survive a restart of the MCP container).

### OpenCode

In `opencode.json` (project root or your global OpenCode config):

```json
{
  "mcp": {
    "servers": {
      "workjournal": {
        "type": "remote",
        "url": "http://127.0.0.1:3738/mcp"
      }
    }
  }
}
```

If you enabled `MCP_AUTH_TOKEN`, OpenCode sends custom headers via the
`headers` field on the server entry:

```json
      "workjournal": {
        "type": "remote",
        "url": "http://127.0.0.1:3738/mcp",
        "headers": { "Authorization": "Bearer <your-token>" }
      }
```

### Cline

In `cline_mcp_settings.json` (CLI: `~/.cline/data/settings/`; IDE: MCP panel →
Configure → **Configure MCP Servers**):

```json
{
  "mcpServers": {
    "workjournal": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:3738/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

With a token enabled, add `"headers": { "Authorization": "Bearer <your-token>" }`.

Any other MCP client that speaks Streamable HTTP works the same way. Clients
that only speak the legacy stdio transport cannot use this endpoint — run the
stdio adapter natively instead (see below).

## Project folders (important)

WorkJournal stores each project's database at `<project-root>/.workjournal/`.
The core service sees container paths, so folders you want to track must be
bind-mounted into the core container. Create `docker-compose.override.yml`
next to `compose.yaml`:

```yaml
services:
  core:
    volumes:
      - /Users/you/code:/projects
```

Restart, then register the project (dashboard → New project) with the container
path, e.g. `/projects/my-repo`. The override file is never touched by upgrades.

## Persistent data and backups

All state lives in the named volume `workjournal-data`, mounted at `/data` in
the core container. It survives `docker compose stop`, `down`, `pull`, `up`
and image upgrades. Only an explicit `down -v` deletes it.

Create a backup (the volume is quiesced first so the WAL is folded in):

```bash
docker compose stop core
docker run --rm -v workjournal_workjournal-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/workjournal-backup.tgz -C /data .
docker compose start core
```

The volume name is prefixed with the Compose project name (`workjournal_` by
default; check `docker volume ls`). Restore by extracting the archive back into
the stopped volume, or into a fresh volume before first start.

Migrations run automatically at core startup, each with its own pre-migration
backup inside `/data` — upgrades never reset the database.

## Stopping and removing

| Command | Containers | Persistent volume |
|---|---|---|
| `docker compose stop` | stopped (reusable) | kept |
| `docker compose down` | removed | **kept** |
| `docker compose down -v` | removed | **deleted** — data loss |

## Upgrading

1. Download the newer release's `compose.yaml` (or set `WORKJOURNAL_VERSION=<new>`
   in a local `.env`).
2. `docker compose pull && docker compose up -d`

Data and your override file are preserved; migrations run on first core startup.

## Configuration

Optional settings go in a `.env` file next to `compose.yaml` — see the released
`.env.example`. Highlights:

- `WEB_PORT` (default 3000), `MCP_HOST_PORT` (default 3738) — host ports, always
  bound to `127.0.0.1`. If you change `MCP_HOST_PORT`, also set
  `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` to the new `host:port` values.
- `MCP_AUTH_TOKEN` — optional bearer token required on every `/mcp` request.
- `LOG_LEVEL` — core log verbosity.

## Security model and limitations

- Published ports bind to `127.0.0.1` only; the core API and SQLite are never
  exposed to the host or LAN.
- The MCP endpoint validates `Host` and `Origin` headers (DNS-rebinding and
  browser-origin protection) and answers unknown paths with 404. Set
  `MCP_AUTH_TOKEN` to additionally require a bearer token on `/mcp`.
- The dashboard has no login (Release 1 design: loopback-only, single user).
- `/health` and `/healthz` are unauthenticated by design and reveal nothing.
- The token, if used, travels over plain HTTP on loopback — do not publish the
  port off-machine (it is bound to loopback by default; keep it that way).

## Development: from-source Compose and stdio

From a source checkout, the root `docker-compose.yml` builds the same images
locally (`docker compose up -d`, tagged `:dev`).

Native development is unchanged — no Docker required:

```bash
cd backend
pnpm install
pnpm dev          # core service on 127.0.0.1:3737
pnpm mcp          # MCP adapter over stdio (spawned by your agent)
cd ../frontend && pnpm dev   # dashboard on 127.0.0.1:5173
```

Two smoke-test scripts are included for a running stack / built adapter:

```bash
docker compose exec -T core mkdir -p /data/projects/demo   # project roots live in the core container
docker compose cp scripts/verify-compose.mjs mcp:/tmp/v.mjs
docker compose exec -T mcp node /tmp/v.mjs    # MCP initialize + tools/list + write via Compose network
node scripts/verify-stdio.mjs                  # stdio transport + down-service error (built dist)
```

The stdio adapter also supports `MCP_TRANSPORT=http` to run the HTTP transport
natively. Adapter environment variables: `MCP_TRANSPORT` (`stdio` default),
`WORKJOURNAL_CORE_URL`, `MCP_HTTP_HOST` (default `127.0.0.1`), `MCP_PORT`
(default 3738), `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_AUTH_TOKEN`.
