# AGENTS.md — WorkJournal Frontend

## What this is

The frontend is a React + Vite + TypeScript single-page application that implements the WorkJournal dashboard. It uses the Coinbase design system (from `DESIGN.md`) applied to task continuity views.

## Tech stack

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript |
| Build | Vite 6 |
| Routing | React Router 6 |
| Styling | CSS custom properties (design tokens) |
| Fonts | Space Grotesk (display + body), Space Mono (code + numbers) |
| API | Fetch → `/api/*` proxied to core service |

## Design system

The UI follows the Neo-Digital Brutalism language from `DESIGN.md`:

- **Structural black** (`#000000`) — all borders, typography structure, solid dark buttons
- **Sharp rectangles** — `0px` radius everywhere; the only curves are brand artwork
- **Graph-paper backdrops** — `#4DA2FF` 24px grid at 25% over white hero/card headers
- **Pop-color blocks** — sunflower `#FFD028`, mint `#00D287`, lilac `#E4D4F8`, blue `#3B82F6`, orange `#FF6B00`
- **Space Grotesk** display/body with tight tracking; **Space Mono** for code tags, ranks, numbers
- **Segmented buttons** — label tile + blue `↗` arrow tile; hover lifts `(-2px, -2px)` with hard shadow
- **Docked grids** — collapsed gutters, shared 1–2px black rules (stats, projects, tasks)
- **Flat elevation** — borders + `4px 4px 0 #000` hard shadows; never blurred shadows

See `src/styles/tokens.css` for the full token set.

## Structure

```
src/
├── components/
│   ├── ui/           # Button, Card, Badge, Input, Textarea, Select, Spinner, EmptyState, StatusBadge, PriorityBadge, Pagination
│   ├── layout/       # TopNav, Footer, PageHeader
│   ├── tasks/        # TaskCard, TaskList, TaskFilters, TaskActions
│   └── projects/     # ProjectCard, ProjectList, ProjectSelect
├── pages/            # HomePage, ProjectsPage, ProjectDetailPage, TaskDetailPage, ResumeContextPage, DocsPage, ApiReferencePage
├── hooks/            # useProjects, useProject, useTasks, useResumeContext, useDashboard
├── lib/              # api client, formatters
└── styles/           # tokens.css, global.css
```

## Development

```bash
# Install dependencies
pnpm install

# Dev server (proxies /api to core on :3737)
pnpm dev

# Type check
pnpm typecheck

# Build
pnpm build
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:3737` — start the backend core service first.

## Rules

1. **No authentication** — loopback only, same origin as core service.
2. **Escape all user content** — React does this by default; never use `dangerouslySetInnerHTML`.
3. **Timestamps in UTC** — convert to local time only at render.
4. **Use design tokens** — never inline hex values; reference `var(--token)` in CSS.
5. **Radius stays 0** — every button, card, badge, input uses `var(--rounded-none)`.
6. **Headlines stay tight** — Space Grotesk 600–700 with negative tracking per type scale.
7. **Arrow tiles on actions** — primary/secondary buttons render the blue `↗` tile via `Button`.
8. **Mono on meta** — versions, timestamps, counts, tags use `var(--font-mono)`.
