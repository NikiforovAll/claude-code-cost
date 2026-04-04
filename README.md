# Claude Code Cost

[![license](https://img.shields.io/npm/l/claude-code-cost)](LICENSE)

> Know what Claude Code costs you — per day, per project, per session.

![Dark mode](assets/screenshot-dark.png)

![Light mode](assets/screenshot-light.png)

## Getting Started

```bash
npx claude-code-cost --open
```

Open http://localhost:3459 (or use `--open` to auto-launch the browser).

That's it. No hooks, no config — the dashboard reads your existing Claude Code session files.

## Features

- **Top-down drill-down** — Total cost → per project → per session → per message
- **Dynamic pricing** — Fetches live model prices from [LiteLLM](https://github.com/BerriAI/litellm), supports tiered pricing (200K threshold), cache token costs, and fast mode multipliers
- **Daily cost chart** — Bar chart with cumulative line, configurable date range (1d / 3d / 7d / 30d / 90d / 1y)
- **Model distribution** — Donut chart showing cost breakdown by model
- **Cache efficiency** — Track how well prompt caching is working across your sessions
- **Project breakdown** — See which projects cost the most, sortable by cost, sessions, or activity
- **Session detail** — Message-level cost breakdown with cumulative cost and token stacked bar charts
- **Dark & light theme** — Matches the Claude Code Hub design system
- **Hub integration** — Works as a tab in Claude Code Hub alongside Kanban and Marketplace
- **Instant reload** — API responses cached in browser; Refresh button for fresh data

## Configuration

```bash
PORT=8080 npx claude-code-cost              # Custom port
npx claude-code-cost --open                 # Auto-open browser
npx claude-code-cost --dir=~/.claude-work   # Custom Claude config dir
```

If port 3459 is in use, the server falls back to a random available port.

### Global install

```bash
npm install -g claude-code-cost
claude-code-cost --open
```

## How It Works

Claude Code writes conversation logs to `~/.claude/projects/` as JSONL files. Each assistant response includes token counts (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) and model info.

The dashboard:
1. **Reads** JSONL session files (streamed line-by-line for large files)
2. **Fetches** live model pricing from LiteLLM (cached 6h, offline fallback included)
3. **Calculates** cost per message using tiered pricing with 200K token threshold
4. **Aggregates** by day, project, and session — all server-side
5. **Renders** with Chart.js — no build step, vanilla JS

Nothing is modified — the dashboard is read-only.

### Cost Calculation

Uses the same pricing logic as [ccusage](https://github.com/ryoppippi/ccusage):

- **Auto mode** — Uses pre-calculated `costUSD` from JSONL when available, otherwise calculates from tokens
- **Tiered pricing** — Tokens above 200K threshold charged at higher rate (Claude 1M context models)
- **Fast mode** — Applies provider-specific multiplier for fast/streaming responses
- **Deduplication** — Skips duplicate messages by `messageId + requestId` hash

## FAQ

**Where does pricing data come from?**
Live from [LiteLLM's pricing dataset](https://github.com/BerriAI/litellm) (2000+ models). Cached for 6 hours. If the fetch fails, a bundled offline snapshot of Claude model prices is used.

**Does it work offline?**
Yes. The offline pricing fallback covers all current Claude models. PWA support included.

**Does it modify any files?**
No. Completely read-only — only reads JSONL files from `~/.claude/projects/`.

**Does it work with Claude Code Hub?**
Yes. Exposes `/hub-config` endpoint and forwards keyboard shortcuts (Ctrl+Alt+Arrow, Alt+1-9) to the hub parent frame.

## License

MIT
