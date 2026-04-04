# Claude Code Cost Dashboard

Cost visualization dashboard for Claude Code usage. Reads JSONL session files from `~/.claude/projects/` and displays costs with top-down drill-down: total → project → session → message.

## Commands

```bash
npm start          # Start server on port 3458
npm run dev        # Start with --open flag
node server.js --port 3000 --open  # Custom port
```

## Architecture

- **server.js** — Express server with pricing module, JSONL parsing, data aggregation
- **public/app.js** — Vanilla JS SPA with Chart.js, no build step
- **public/style.css** — CSS variables, dark/light theme (matches cck + marketplace)

## Data Flow

```
~/.claude/projects/**/*.jsonl → server.js (parse + aggregate) → REST API → app.js (render + Chart.js)
```

## Pricing

Dynamic pricing from LiteLLM (`model_prices_and_context_window.json`). Supports tiered pricing (200k threshold), cache token costs, fast mode multiplier. Offline fallback included.

## Conventions

- Vanilla JS only, no frameworks, no build step
- `#region` markers in all JS/CSS files
- CSS variables for theming (shared with cck/marketplace)
- Hub integration via `/hub-config` + `window.__HUB__`

## app.js Regions

STATE, UTILS, URL_STATE, FETCH, RENDER_OVERVIEW, RENDER_PROJECTS, RENDER_SESSIONS, RENDER_DETAIL, CHARTS, THEME, ROUTER, TOAST, HUB_INTEGRATION, INIT

## style.css Regions

VARIABLES, RESET, SCROLLBAR, TOPBAR, LAYOUT, CARDS, CHARTS, TABLE, BREADCRUMB, DETAIL, LOADING, TOAST, LIGHT_THEME, RESPONSIVE
