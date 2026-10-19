# 06 — PM Review Checklist

Use this as the sign-off sheet. Check each box by running the thing, not by
reading about it. References point back into this pack.

## A. It runs (→ `02-how-to-run.md`)

- [ ] `pnpm install` completes with no errors.
- [ ] Core starts: `backend → pnpm dev` prints the `http://127.0.0.1:3737` line.
- [ ] Dashboard starts: `frontend → pnpm dev`, `http://localhost:5173` loads
      with stats (not error banners).
- [ ] `backend → pnpm test` → 9 files / 36 tests pass.
- [ ] `frontend → npm run typecheck` clean; `npm run build` emits `dist/`.

## B. It navigates (→ `03-how-to-navigate.md`)

- [ ] Home scope picker filters stats + recents, writes shareable `?scope=`,
      survives reload; bogus scope falls back to All.
- [ ] Mobile width (≤640px): nav picker hides, inline scope bar is usable with
      no overflow; desktop shows exactly one picker.
- [ ] New Project → Browse → server picker shows full paths, breadcrumbs,
      filter, `[wj]` markers → picking fills Root Path with an absolute path →
      Create succeeds. (If it shows a bare folder name, hard-refresh: that's
      the old cached bundle.)
- [ ] Unavailable project (moved folder) shows guidance, never a crash.
- [ ] Task detail: history, checkpoints, decisions, resume view, JSON + Markdown
      export all render.
- [ ] Stats `Projects` equals the registered total whether or not a scope is
      selected (scope-independence fix).

## C. Agents can use it (→ `04-mcp-for-agents.md`)

- [ ] Adapter config points at the running core (`WORKJOURNAL_CORE_URL` or
      default); tools list loads in the MCP client.
- [ ] `get_dashboard` → `get_resume_context` → `claim_task` → checkpoint →
      decision → `complete_task` round-trips on a scratch task.
- [ ] Core stopped → tool call returns the actionable start-service error.
- [ ] Same write replayed with same key + input → stored response, no
      duplicate; same key + changed input → `409`.

## D. Scope & risks (→ `01-project-overview.md`, `05-architecture-and-data.md`)

- [ ] Accepted: local-only, no login, no cloud, no auto-start, no page-number
      pagination, tiny tables unpaginated.
- [ ] Data locations confirmed: `~/.workjournal/registry.db` (index) +
      `<root>/.workjournal/workjournal.db` per project (truth). Nothing else
      touched.
- [ ] Open items listed: live re-verification after core restart; Host/Origin
      checks deferred; blurred-scrim fallback if dither reads as noise (D-007).

## Sign-off

| Role | Name | Date | Verdict |
|------|------|------|---------|
| PM | | | ☐ Approve ☐ Approve with notes ☐ Request changes |
| Developer (meetb) | | | notes: |

_Notes / requested changes:_
