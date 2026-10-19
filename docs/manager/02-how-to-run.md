# 02 — How to Run WorkJournal

You need **Node.js ≥ 22** and **pnpm**. No accounts, no tokens, no cloud —
everything binds to `127.0.0.1` (this machine only).

## The three pieces

| Piece | What it is | Default address |
|-------|-----------|-----------------|
| Core service (backend) | Fastify API + SQLite storage. **Must be running** — it owns all data access | `http://127.0.0.1:3737` |
| Dashboard (frontend) | React + Vite UI, proxied to the core | `http://localhost:5173` |
| MCP adapter | stdio bridge so AI agents can call WorkJournal as tools | no port (spawns per session) |

## First-time setup (from the repo root)

```powershell
# 1. Install everything (backend + frontend workspaces)
pnpm install

# 2. Start the core service (terminal 1 — keep it running)
cd backend
pnpm dev
# expect: "WorkJournal core service running at http://127.0.0.1:3737"

# 3. Start the dashboard (terminal 2)
cd frontend
pnpm dev
# expect: Vite serving at http://localhost:5173
```

Open **`http://localhost:5173`** in a browser. If the dashboard shows errors,
the core service (step 2) is almost certainly not running — the UI never talks
to SQLite directly, it always goes through the core.

## Everyday commands

| Goal | Command | Where |
|------|---------|-------|
| Start core (dev, auto-reload) | `pnpm dev` | `backend/` |
| Start dashboard (dev) | `pnpm dev` | `frontend/` |
| Backend tests (36, real SQLite in temp dirs) | `pnpm test` | `backend/` |
| Backend typecheck / lint | `pnpm typecheck` / `pnpm lint` | `backend/` |
| Frontend typecheck | `npm run typecheck` | `frontend/` |
| Frontend production build | `npm run build` | `frontend/` |
| Production start (core) | `pnpm start` | `backend/` |

## Configuration (all optional)

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKJOURNAL_HOME` | `~/.workjournal` | Where the global registry DB lives |
| `PORT` / `HOST` | `3737` / `127.0.0.1` | Core service bind (keep loopback) |
| `LOG_LEVEL` | `info` | `silent` in tests |
| `WORKJOURNAL_CORE_URL` | `http://127.0.0.1:3737` | Where the MCP adapter finds the core |

## Where data lands (so nothing surprises you)

- **Registry:** `<WORKJOURNAL_HOME>/registry.db` — project references only
  (id, name, root path). Rebuildable by re-registering folders.
- **Each project:** `<project-root>/.workjournal/workjournal.db` — its tasks,
  events, checkpoints, decisions. This is the source of truth.
- The installer never touches files outside those two locations.

## Troubleshooting for the reviewer

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Dashboard shows "Error loading…" everywhere | Core service down | Start `backend → pnpm dev`, refresh |
| `Project … is unavailable` banner | Folder moved/deleted after registering | Re-register from its current path; nothing crashes |
| Browse button shows an error modal | Core down (browse is a `GET /api/projects/browse` call) | Start core, click "Back to roots" |
| Create Project → "folder does not exist" | Typed path has a typo, or a bare folder name without its parent | Use Browse to pick the full path, or fix the spelling |
| Port 3737/5173 in use | Another instance running | Stop it, or set `PORT=` for the core |
