# 03 — How to Navigate the Dashboard

Start at **`http://localhost:5173`** (core service must be running — see
`02-how-to-run.md`). Design language is Neo-Brutalism: sharp rectangles, 2px
black structure, graph-paper banners, hard offset shadows, Space Grotesk +
Space Mono. What follows is a click-path for review.

## Top nav (every page)

- **Brand `W` WorkJournal** → home. **Home / Projects / Docs** segments
  highlight by page (yellow / blue / lilac).
- **`</scope>` picker (home route only):** project scope dropdown. `All
  projects` or one project — selection lands in the shareable `?scope=` URL
  param, drives the stats band + Recent Tasks, and survives reload/bookmark.
- **Status dot (right):** core-service indicator.

## Home (`/`)

1. **Hero** — "Task Continuity for AI Agents" + illustration in a brutalist
   frame. `View Projects` button → `/projects`.
2. **Scope bar (mobile only):** below the hero on narrow screens — same picker
   as the nav (the nav picker hides ≤640px so the bar never duplicates).
3. **Stats band** — `Projects` (registry total, scope-independent), `Active
   Tasks`, `Completed`, `Blocked`. Scoping a project narrows the task numbers
   but never the project count.
4. **Recent Tasks** — newest first, `View all` → `/projects`.

*Try:* pick a project in the scope control → URL gains `?scope=<id>`, stats and
recents filter, list of projects stays global. Try a bogus `?scope=nope` → falls
back to All instead of erroring.

## Projects (`/projects`)

- **Project cards** — name, availability, task counts. A moved/deleted folder
  shows `unavailable` with guidance; the page never crashes.
- **New Project** → `</new-project>` modal: name, description, **Root Path**
  (text field + **Browse** button + hint).
  - **Browse** opens the `</choose-folder>` server-side picker: current full
    path bar, breadcrumbs (`[roots] / …`), filter box, `↑ Up`, folder rows
    (`[dir]`, `[wj]` marks folders already containing `.workjournal`).
    Single-click drills in, double-click picks, **Use this folder** confirms
    the current directory into Root Path as a real absolute path.
  - Manual typing still works; the backend rejects non-existent folders with an
    actionable message.
- **Pagination:** task lists page 25 at a time ("next" style, no page numbers).

## Project detail (`/projects/:id`)

- Project header, its task list (25/page), and entry points to create tasks.
- Each task row → task detail.

## Task detail (`/tasks/:id`)

- Title, status/priority badges, objective, acceptance criteria.
- **Actions** (claim, block, complete, …) enforce ownership + version — acting
  on someone else's task or a stale version is rejected with a clear error.
- **History:** chronological event log; **checkpoints** (progress notes);
  **decisions** (choice + rationale + rejected alternatives, supersede history
  preserved).
- **Resume (`/resume/:taskId`)** — the deterministic next-agent brief.
- **Export** — JSON (machine) / Markdown (human) handoff, secrets filtered.

## Docs (`/docs`, `/docs/api`)

- In-app documentation and the **API reference table** (all endpoints, error
  catalog: `VALIDATION_ERROR`, `NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`,
  `STALE_VERSION`, `INVALID_TRANSITION`).

## Suggested 5-minute review path

1. Home → scope to one project → confirm URL + filtering.
2. Projects → New Project → Browse → pick a folder → verify the full path
   lands in Root Path → Create.
3. Open a task → history/checkpoints/decisions tabs → Resume view → export
   Markdown.
4. Docs → API reference → compare any endpoint against the table.
