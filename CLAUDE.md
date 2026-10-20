# Claude Code Cost Dashboard

Cost visualization dashboard for Claude Code usage. Reads JSONL session files from `~/.claude/projects/` and displays costs with top-down drill-down: total → project → session → message.

## Commands

```bash
npm start          # Start server on port 3543
npm run dev        # Start with --open flag
node server.js --port 3000 --open  # Custom port
```

## Architecture

- **server.js** — the bin: runs a CLI command (`lib/cli.js`) when the first argument is one, else starts the server (`lib/app.js`)
- **lib/costs.js** — pricing, JSONL parsing, aggregation and query parsing; shared by the server and the CLI
- **lib/app.js** — Express routes and startup; writes `<config dir>/.cost/server.json` (`{pid, port, script}`; cck reads `script` to name the CLI to Kanbot) once it listens and removes it on exit
- **lib/cli.js** — `claude-code-cost <command>`: asks the server of the config dir (`COST_URL`, else `server.json` with a live pid), else parses in-process. Commands, flags and help live in its `COMMANDS` table. The help is read by agents (Kanbot), so keep each line short
- **public/app.js** — Vanilla JS SPA with Chart.js, no build step
- **public/style.css** — CSS variables, dark/light theme (matches cck + marketplace)

## Data Flow

```
~/.claude/projects/**/*.jsonl → lib/costs.js (parse + aggregate) → REST API → app.js (render + Chart.js)
                                                        └→ lib/cli.js (no server running)
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
