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

## Project folders and `PROJECTS_DIRECTORY` (important)

### How it works

WorkJournal stores each project's database at `<project-root>/.workjournal/`.
When running in Docker, the **core service** is the only component that touches
project folders — it must be able to read and write those folders. The dashboard
and MCP adapter communicate with core over HTTP and never touch the filesystem.

To make host folders visible to the core container, set the `PROJECTS_DIRECTORY`
environment variable. Compose then bind-mounts that directory into the core
container at `/host-projects` (read-write). The dashboard folder picker and
registration API accept both host paths (e.g., `C:/Users/you/code/my-repo`) and
container paths (`/host-projects/my-repo`); they are mapped transparently.

### Setting `PROJECTS_DIRECTORY`

| Platform | Example value |
|---|---|
| Windows (Docker Desktop) | `C:/Users/you/code` |
| macOS (Docker Desktop) | `/Users/you/code` |
| Linux (Docker Engine) | `/home/you/code` |

**Windows note:** Use forward slashes (`/`) or double backslashes (`\\`) in
the `.env` file. The value must point to an existing directory.

**Docker Desktop file sharing (Windows/macOS):** The `PROJECTS_DIRECTORY` folder
**must** be added to Docker Desktop → Settings → Resources → File Sharing
(before starting Compose). Without this, the bind mount fails and core will
report an actionable error at startup:

```
PROJECTS_DIRECTORY is set (C:/Users/you/code) but /host-projects is not
readable/writable inside this container. Docker Desktop: enable the
drive/folder under Settings → Resources → File sharing, then recreate the core
container.
```

### Registration flow

1. Start the stack with `PROJECTS_DIRECTORY` set.
2. In the dashboard → **New Project**, either:
   - Click **Browse** and pick a folder under the mounted root, **or**
   - Enter the host path (e.g., `C:/Users/you/code/my-repo`) or the container
     path (e.g., `/host-projects/my-repo`).
3. The core service:
   - Maps the supplied path to its container form (`/host-projects/...`).
   - Verifies the folder exists inside the container.
   - Creates `<folder>/.workjournal/workjournal.db` (lazy initialization).
   - Registers the project in the global registry with the **container path**
     as `root_path`.

Re-registering the same folder (any path form: host, container, with/without
trailing slash) returns the **same project ID** — initialization is idempotent.

### Identity rules

| Concept | Rule |
|---|---|
| **Project ID** | Stable UUID (e.g., `oroview-3f9a`). Never contains `_`. |
| **Project name** | Human-readable label. Can change; does not affect identity. |
| **Root path** | The **container path** (`/host-projects/...`) is the canonical key. Two folders with the same name under different parents are distinct projects. |
| **History stays with the folder** | If you move/rename a folder on the host, it registers as a **new project** (new ID, new `.workjournal/`). The old project remains in the registry, marked `available: false`. Its tasks, events, checkpoints, and decisions are preserved in the old folder's `.workjournal/`. |

### Move / rename / delete behavior

| Host action | Result |
|---|---|
| **Move folder** to a different parent (outside `PROJECTS_DIRECTORY`) | Old project → `unavailable`. New location → registers as a new project with new ID. |
| **Rename folder** in place | Same as move: old ID unavailable, new registration = new ID. |
| **Delete folder** | Project marked `unavailable`. Reads/writes against it return 404 with an actionable message. Other projects are unaffected. |
| **Restore folder** at original path | Re-registration reuses the same project ID (idempotent by `root_path`). |

### Backup of volume + project artifacts

Two layers of persistence exist:

1. **Registry volume (`workjournal-data`)** — holds the global registry SQLite
   (`registry.db` with `registry_projects`, `registry_idempotency`). Backed up
   by stopping core and archiving the volume (see "Persistent data and backups"
   below).
2. **Per-project `.workjournal/` folders** — each project has its own SQLite
   database, WAL files, and any exports. These live **inside the project folder**
   on the host (via the `/host-projects` mount). To fully back up a project,
   back up the entire project folder (including `.workjournal/`). Restoring a
   project means placing the folder back under `PROJECTS_DIRECTORY` and
   re-registering it (same ID, history intact).

**Recommended backup strategy:**

```bash
# 1. Stop core to quiesce the registry volume
docker compose stop core

# 2. Archive the registry volume
docker run --rm -v workjournal_workjournal-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/workjournal-registry-backup.tgz -C /data .

# 3. Archive each project folder (includes .workjournal/)
tar czf workjournal-project-myapp.tgz -C /host/projects myapp

# 4. Restart
docker compose start core
```

### Host vs Container Path Responsibilities

| Responsibility | Host Path (`C:/Users/...` or `/home/...`) | Container Path (`/host-projects/...`) |
|---|---|---|
| **User input (dashboard, API, MCP)** | ✅ Accepted | ✅ Accepted |
| **Display (dashboard, API responses)** | ✅ Used for display | — |
| **Filesystem operations (core only)** | — | ✅ Exclusive |
| **Registry storage (`root_path`)** | — | ✅ Stored as container path |
| **Project DB location** | — | `<container-path>/.workjournal/` |
| **Docker Compose mount** | Source of bind mount | Target: `/host-projects` |
| **Docker Desktop file sharing** | Must be shared | — |

### Path mapping examples

| `PROJECTS_DIRECTORY` | User supplies | Core sees (`root_path`) | Dashboard displays |
|---|---|---|---|
| `C:/Users/you/code` | `C:/Users/you/code/myapp` | `/host-projects/myapp` | `C:/Users/you/code/myapp` |
| `C:/Users/you/code` | `/host-projects/myapp` | `/host-projects/myapp` | `C:/Users/you/code/myapp` |
| `/home/you/code` | `/home/you/code/myapp` | `/host-projects/myapp` | `/home/you/code/myapp` |
| (unset, native dev) | `/any/native/path` | `/any/native/path` | `/any/native/path` |

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
