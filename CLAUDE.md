# Claude Code Cost Dashboard

Cost visualization dashboard for Claude Code usage. Reads JSONL session files from `~/.claude/projects/` and displays costs with top-down drill-down: total → project → session → message.

## Commands

```bash
npm start          # Start server on port 3543
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

## Regions

List them from the source rather than from this doc — a copied list drifts:
`rg '#region' public/app.js public/style.css`

Find one region: `rg '#region CHARTS' public/`. Read it: from `#region` to `#endregion`.
When changing a feature, open both the JS region and the matching CSS region — the names usually match.
