# Claude Code Cost

[![npm version](https://img.shields.io/npm/v/claude-code-cost)](https://www.npmjs.com/package/claude-code-cost)
[![license](https://img.shields.io/npm/l/claude-code-cost)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/claude-code-cost)](https://www.npmjs.com/package/claude-code-cost)

See what [Claude Code](https://docs.anthropic.com/en/docs/claude-code) costs you per day, project, session, and message.

**[Documentation](https://nikiforovall.blog/claude-code-cost/)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/public/shots/themes/ember-h2-hub-cost-dark.webp">
  <img alt="The Overview tab: cost cards, a daily cost chart stacked by model, a Cost by Model chart, and the Projects table" src="website/public/shots/themes/ember-h2-hub-cost-light.webp">
</picture>

## Getting started

You need Node.js 20 or later and a Claude config dir with at least one session.

```bash
npx claude-code-cost --open
```

The server starts on `http://localhost:3543` and `--open` opens it in your browser. If the port is in use, the server picks a random free port and prints the real URL.

You do not need hooks, plugins, or a config file. The dashboard reads the session logs that Claude Code already writes to `~/.claude/projects/` and never writes to them. Your transcripts and cost data stay on your machine. The server downloads the LiteLLM price list, and the Plan usage dialog runs your local `claude` CLI. See [What it reads and what it sends](https://nikiforovall.blog/claude-code-cost/getting-started/#what-it-reads-and-what-it-sends).

### Install as a desktop app

The dashboard is a PWA. With the server running, open it in Chrome or Edge and click **Install** in the top bar, or the install icon in the address bar. The app opens in its own window. Right-click its icon for the **Overview** and **Insights** shortcuts. The server must still run, because the app is a window onto the local URL.

## Features

- **Drill down from the total to one message.** Open a project to see its sessions, then a session to see each message. <kbd>Backspace</kbd> goes back one level.
- **Session detail.** A cumulative cost curve, the tokens of each message, and a table with the model, the tools it called, and the running total. Subagents and Workflow runs are in the totals, with a row per agent. Compactions show with an estimated summarizer cost. A range brush picks which messages to show in long sessions.
- **Date ranges.** Presets from Today and Last 24h up to 1 Year, or two dates on a calendar. The range and the project scope apply to every view.
- **Insights.** The active 5-hour block with its time left, burn rate, monthly run-rate, cache savings, and subagent share. Charts for token composition, top tools, an hourly heatmap, and weekly cost, plus a table of past 5-hour blocks.
- **Plan usage.** Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> to see your plan windows, the percent used, and what drives the cost.
- **Pricing.** Live prices from the [LiteLLM](https://github.com/BerriAI/litellm) price list, with the 200K-token tier, cache reads and writes, and fast mode. A built-in table fills in when the list cannot load. Streamed lines are counted once per `message.id` plus `requestId`.
- **Keyboard.** <kbd>1</kbd> and <kbd>2</kbd> switch between Overview and Insights. <kbd>↓</kbd>/<kbd>↑</kbd> or <kbd>J</kbd>/<kbd>K</kbd> move through rows, and <kbd>Enter</kbd> opens one. Press <kbd>?</kbd> for the full list.
- **17 color themes**, each in light and dark.
- **Claude Code Hub.** Runs standalone or as a tab in [Claude Code Hub](https://github.com/NikiforovAll/claude-code-hub), with a shared project scope and theme.

All numbers are estimates from token counts and public list prices, not a bill. See [How costs are computed](https://nikiforovall.blog/claude-code-cost/how-costs-are-computed/).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/public/shots/themes/ember-h2d-hub-cost-sessions-dark.webp">
  <img alt="A project's sessions view: daily cost by model, Cost by Model, Total Cost, and the sessions table" src="website/public/shots/themes/ember-h2d-hub-cost-sessions-light.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/public/shots/themes/ember-cost-detail-dark.webp">
  <img alt="Session detail: stat header, Cumulative Cost and Token Breakdown per Message charts, the range brush, and the messages table" src="website/public/shots/themes/ember-cost-detail-light.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/public/shots/themes/ember-cost-insights-dark.webp">
  <img alt="Insights: active 5-hour block, burn rate, run-rate, cache savings and subagent share cards, charts, and the 5-hour billing blocks table" src="website/public/shots/themes/ember-cost-insights-light.webp">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/public/shots/themes/ember-h2g-hub-cost-range-dark.webp">
  <img alt="The date range picker with presets from Today to 1 Year and a two-month calendar" src="website/public/shots/themes/ember-h2g-hub-cost-range-light.webp">
</picture>

## Configuration

A flag wins over its environment variable. Flags take a value as `--port 3000` or `--port=3000`.

| Flag | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `--port <n>` | `PORT` | `3543` | Port to listen on. Falls back to a random port if busy. |
| `--dir <path>` | `CLAUDE_CONFIG_DIR`, then `CLAUDE_DIR` | `~/.claude` | Claude config dir to read. |
| `--open` | | off | Open the dashboard in your browser. |
| `--host <addr>` | `HOST` | `127.0.0.1` | Address to bind. |
| `--allowed-hosts=<list>` | `ALLOWED_HOSTS` | empty | Extra host names to accept, on top of loopback names. |
| | `CLAUDE_BIN` | `claude` (`claude.exe` on Windows) | Claude Code executable for Plan usage. |

With a custom config dir, the server reads only `<dir>/projects`. With the default dir, it also reads `~/.config/claude/projects`.

The server has no authentication. Bind a non-loopback address only on a network you trust. See [Configuration and CLI](https://nikiforovall.blog/claude-code-cost/reference/configuration/) for the network rules and the HTTP API.

## Documentation

- [Getting started](https://nikiforovall.blog/claude-code-cost/getting-started/)
- [Read the overview](https://nikiforovall.blog/claude-code-cost/guides/overview/)
- [Trace a project to a message](https://nikiforovall.blog/claude-code-cost/guides/sessions/)
- [Watch 5-hour blocks and burn rate](https://nikiforovall.blog/claude-code-cost/guides/insights/)
- [Choose a date range and project scope](https://nikiforovall.blog/claude-code-cost/guides/ranges-and-scope/)
- [How costs are computed](https://nikiforovall.blog/claude-code-cost/how-costs-are-computed/)
- [Keyboard shortcuts](https://nikiforovall.blog/claude-code-cost/reference/keyboard-shortcuts/)
- [Run inside Claude Code Hub](https://nikiforovall.blog/claude-code-cost/reference/claude-code-hub/)
- [Troubleshooting](https://nikiforovall.blog/claude-code-cost/reference/troubleshooting/)

## License

MIT
