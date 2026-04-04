# Claude Code Cost Dashboard — Planning Context

## What
Build `claude-code-cost` — a cost dashboard web app for Claude Code Hub. It visualizes Claude Code usage costs with a **top-down drill-down** approach: total costs → per-project → per-session.

## Why
The ecosystem has 10+ CLI/TUI cost tools (ccusage, ccburn, ccost, tokscale) but **no polished embeddable web dashboard**. This fills that gap as a new tab in Claude Code Hub alongside kanban and marketplace.

## How

### Architecture (match sibling apps exactly)
Follow the same Express + vanilla JS + no-build-step pattern used by:
- `../cck/` — kanban app (Express + chokidar + SSE + vanilla JS)
- `../claude-code-marketplace/` — marketplace app (Express + vanilla JS)

Study these reference codebases (available via --add-dir):
- **Server pattern**: `server.js` with Express, CLI args (--port, --open), `/hub-config` endpoint, static serving
- **Frontend pattern**: `public/app.js` with #region markers, vanilla JS, HTML string rendering, no frameworks
- **Theme system**: CSS variables, dark/light toggle, IBM Plex Mono + Playfair Display fonts, orange accent (#e86f33)
- **Hub integration**: `/hub-config` endpoint, `window.__HUB__`, postMessage forwarding (Ctrl+Alt+Arrow, Alt+1-9)
- **Real-time updates**: chokidar file watchers + SSE broadcasting (from cck)

### Pricing — CRITICAL
**DO NOT hardcode model prices.** Study `../ccusage-reference/` source code to understand how ccusage handles pricing dynamically. Use the same approach (whether it's a pricing module, API fetch, or configurable table). The dashboard must stay accurate as models/prices evolve.

### Data Sources (all local filesystem, no external APIs)

1. **~/.claude/projects/{path}/{session-id}.jsonl** — Raw conversation logs. Each assistant message has:
   ```json
   "usage": {
     "input_tokens": 3,
     "cache_creation_input_tokens": 15696,
     "cache_read_input_tokens": 0,
     "output_tokens": 143
   }
   ```
   Plus `model`, `timestamp`, `sessionId`. This is the primary source for accurate cost calculation.

2. **~/.claude/stats-cache.json** — Pre-computed daily aggregates:
   - `dailyActivity[]`: date, messageCount, sessionCount, toolCallCount
   - `dailyModelTokens[]`: date, tokensByModel (model name → total tokens)

3. **~/.claude/usage-data/session-meta/{id}.json** — Per-session metadata:
   - input_tokens, output_tokens, project_path, start_time, duration_minutes
   - tool_counts, first_prompt, uses_mcp, uses_web_search, lines_added/removed

4. **~/.claude/usage-data/facets/{id}.json** — Session quality/outcome metadata

### UI — Top-Down Drill-Down
The dashboard should flow top-down:
1. **Overview cards** — Total cost today/this week/this month, total sessions, total tokens
2. **Daily cost trend** — Line/bar chart with 7-day moving average
3. **Per-project breakdown** — Table/cards showing cost per project, sortable
4. **Per-session details** — Click project to see sessions, click session for message-level cost
5. **Supporting charts** — Token breakdown (input/output/cache stacked bar), model distribution (donut), cache efficiency ratio, activity heatmap

### Tech Stack
- Express.js + chokidar + SSE (server)
- Vanilla JS with #region markers (frontend)
- Chart.js via CDN (charts)
- CSS variables for dark/light theme
- PWA-ready (manifest.json, sw.js, icons/)

## When (Scope)
- Plan mode only — design the full implementation plan
- Core cost dashboard features first
- Hub integration included from the start
- No external API dependencies (all local data)

## Target Structure
```
claude-code-cost/
├── server.js
├── package.json
├── CLAUDE.md
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── sw.js
│   ├── manifest.json
│   └── icons/
```
