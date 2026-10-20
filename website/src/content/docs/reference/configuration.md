---
title: Configuration and CLI
description: Flags, environment variables, the command line, network behavior, and the HTTP API of the Claude Code Cost server.
---

Claude Code Cost is one Node.js server (Node.js 20 or later). It reads your session transcripts and serves the dashboard and a small JSON API. You set the server with flags or environment variables. The same bin also answers cost questions from the command line.

```bash
npx claude-code-cost --port 3600 --dir ~/.claude-work --open
```

## Flags and environment variables

A flag wins over its environment variable. Flags take a value as `--port 3000` or as `--port=3000`.

| Flag | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `--port <n>` | `PORT` | `3543` | Port to listen on. |
| `--dir <path>` | `CLAUDE_CONFIG_DIR`, then `CLAUDE_DIR` | `~/.claude` | Claude config dir to read. A leading `~` expands to your home dir. |
| `--open` | | off | Opens the dashboard in your default browser after the server starts. |
| `--host <addr>` | `HOST` | `127.0.0.1` | Address to bind. |
| `--allowed-hosts=<list>` | `ALLOWED_HOSTS` | empty | Comma-separated host names to accept in the `Host` header, on top of loopback names. |
| | `CLAUDE_BIN` | `claude.exe` on Windows, `claude` elsewhere | The Claude Code executable for the plan usage probe. |
| | `CLAUDE_HUB`, `HUB_URL` | unset | Hub mode. Claude Code Hub sets these for you. |

In a clone of the repository, `npm run dev` runs `node server.js --open`.

### Port

If the port is in use, the server logs `Port <n> in use, trying random port...` and listens on a random free port. The startup banner shows the port it got:

```text
Claude Code Cost Dashboard running at http://localhost:<port>
```

### Config dir

The server reads transcripts from `<config dir>/projects`. With the default `~/.claude`, it also reads `~/.config/claude/projects`. A custom dir reads only its own `projects` folder, so sessions from your home profile do not show up in it. See [How costs are computed](/claude-code-cost/how-costs-are-computed/) for what it does with those files.

### Plan usage probe

The Plan usage dialog (<kbd>Ctrl+Shift+S</kbd>) runs `claude -p` in stream-json mode with `CLAUDE_CONFIG_DIR` set to the same config dir. It sends one `get_usage` control request. No model turn runs. The probe starts a full CLI process, so it fires the SessionStart hooks of that config dir. The server keeps the result for 5 minutes and stops the probe after 60 seconds. Set `CLAUDE_BIN` if `claude` is not on your `PATH`.

### Startup

At startup the server fetches model prices from LiteLLM. It fetches them again at most every 6 hours. If the fetch fails and it has no prices yet, it uses a small built-in table.

## Command line

`claude-code-cost <command>` prints costs in the terminal. `claude-code-cost help` lists the commands, and `claude-code-cost help <command>` gives the flags and examples of one command.

| Command | Prints |
| --- | --- |
| `overview` | Total cost, cost by model, by day, and the top projects. |
| `insights` | Run rate, 5-hour blocks, subagent share, and top tools. |
| `projects` | Projects by cost. |
| `sessions <project>` | Sessions of one project by cost, with their ids. `<project>` is a name, part of a name, or the encoded folder name. |
| `session <id>` | One session: totals, subagents, and the costliest turns. |
| `agent <session> <agent id>` | One subagent of a session. |
| `limits [--refresh]` | Plan usage limits. |

Every command takes `--json` (the API response), `--top <n>` (rows per list, default 5), and `--dir <config dir>`.

```bash
claude-code-cost overview --range 30d
claude-code-cost sessions claude-code-hub --range today --top 10
claude-code-cost session d3a7c2e1-5b4f-4c8e-9a12-6f0e8b7d4c31 --json
```

### Window

The window comes from the first of these that is set:

1. `--range` (`today`, `24h`, or `<n>d` up to `365d`), or `--from` and `--to` (`YYYY-MM-DD`, at most 365 days).
2. The `CLAUDE_COST_RANGE` environment variable.
3. `cli.defaultRange` in `<config dir>/.cost/config.json`, for example `{"cli": {"defaultRange": "30d"}}`.
4. `7d`.

A bad flag is an error. A bad environment or config value prints a warning and is skipped.

### Server or files

Once it listens, the server writes `<config dir>/.cost/server.json` with its pid, port and the path of its `server.js`, and removes the file when it stops. A command asks that server, so the answer is quick and matches the dashboard. Set `COST_URL` to ask a server at another URL. With no live server, the command parses the transcripts itself and prints a note on stderr. That takes about 1 second for today and 3 to 6 seconds for 7 days or more. It fetches the LiteLLM prices on each run.

## Network and security

The server has no authentication. Anyone who can reach its port can read your Claude Code history. These defaults keep it local:

- It binds `127.0.0.1`. On a loopback bind it also listens on the other loopback family (`::1`) on the same port, so `http://localhost:<port>` works whichever way `localhost` resolves.
- It answers only requests whose `Host` header is a loopback name, a name in `--allowed-hosts`, or the address you bound. Other requests get `403`. This blocks DNS rebinding, where a web page points its own host name at `127.0.0.1` to read local data.
- A request other than `GET`, `HEAD`, or `OPTIONS` with an `Origin` header must come from the hub origin or a loopback origin. If that loopback origin has a port, it must be the server's port. Other origins get `403`. If the request has no `Origin` header and its `Sec-Fetch-Site` is not `same-origin` or `none`, it gets `403`.
- When `HUB_URL` is not set, the server sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other page can frame it. When `HUB_URL` is set, the server allows framing from `http://localhost:*`, `http://127.0.0.1:*`, and the hub origin, and it does not send `X-Frame-Options`.

To reach the dashboard from another machine, bind a non-loopback address and allow the host name you will use:

```bash
npx claude-code-cost --host 0.0.0.0 --allowed-hosts=my-box.local
```

The server then prints this warning:

```text
WARNING: listening on 0.0.0.0 - reachable from your network, with no authentication.
```

Do this only on a network you trust.

## Hub mode

When `CLAUDE_HUB` is set, the dashboard runs as a tab in Claude Code Hub. `HUB_URL` gives the hub origin. The origin checks and framing rules follow from `HUB_URL`: the server accepts that origin for `POST` requests and as a framing ancestor. See [Run inside Claude Code Hub](/claude-code-cost/reference/claude-code-hub/).

## HTTP API

All routes in this table return JSON. The guards answer blocked requests with a plain-text `403`.

| Route | Returns |
| --- | --- |
| `GET /api/overview` | Totals, today's cost, sessions, tokens, cache efficiency, cost series, cost by model, and projects. |
| `GET /api/insights` | 5-hour blocks, burn rate, run rate, cache savings, token composition, top tools, heatmap, subagent share, and weekly cost. |
| `GET /api/projects` | Projects with cost, sessions, and last activity. |
| `GET /api/projects/:path/sessions` | Sessions of one project. `:path` is the encoded project folder name. |
| `GET /api/sessions/:id` | One session, all time, with in-range and today slices. `404` if the session does not exist. |
| `GET /api/sessions/:id/agents/:agentId` | One subagent of a session. `404` if it does not exist. || `GET /api/usage-limits` | Plan usage from the probe. Add `?refresh=1` to skip the 5-minute cache. `503` if the probe fails. |
| `GET /api/pricing` | The loaded prices, only for models whose name starts with `anthropic/` or `claude`. |
| `POST /api/refresh` | Clears the server cache. Returns `{"ok": true}`. It does not fetch prices again. |
| `GET /hub-config` | `{"enabled": true, "url": <HUB_URL>}`. Only when the hub runs the app. |

The server keeps computed results for 30 seconds.

### Query parameters

The GET data routes (`/api/overview`, `/api/insights`, `/api/projects`, `/api/projects/:path/sessions`, and `/api/sessions/:id`) take a date range:

- `range=today` starts at local midnight.
- `range=24h` is the rolling last 24 hours.
- `range=<N>` is the last N calendar days, ending today.
- `from=YYYY-MM-DD&to=YYYY-MM-DD` is a custom window of whole local days. It wins over `range`. If `from` is after `to`, the server swaps them. Dates after today become today. A malformed date, or only one of the two, gives `400` with `Invalid date range`.

With no range, `/api/overview` and `/api/insights` use 30 days. The other routes use all time. The dashboard itself starts on 3 Days, and it always sends the range you pick.

`/api/overview`, `/api/insights`, and `/api/projects` also take `project=<encoded dir>`, the encoded project folder name. To sum several projects as one, for example a repo and its worktrees, join their folder names with commas. `/api/projects/:path/sessions` takes the same list as `:path`. Each name must match `[A-Za-z0-9._-]+`, else the server returns `400` with `Invalid project`.

```bash
curl "http://localhost:3543/api/overview?range=7"
curl "http://localhost:3543/api/overview?from=2026-09-01&to=2026-09-15"
```

## Browser storage

The dashboard keeps your choices in `localStorage` on its own origin:

| Key | Holds |
| --- | --- |
| `cc-cost:range` | The date range. |
| `cc-cost:scope` | The project scope. |
| `cc-cost:view` | The last top-level tab, Overview or Insights. |
| `cc-cost:sort:<view>` | The table sort for each view. |
| `theme` | `light` or `dark`. |
| `color-theme` | The color theme. Not set means Ember. |

It keeps the current view, project, and session in `sessionStorage` under `cc-cost:nav`, and in the URL. API responses stay in memory for 5 minutes and never go to storage.

## Themes

There are 17 color themes, each in light and dark: Ember (the default), Gruvbox, Catppuccin, Tokyo Night, Solarized, Dracula, Nord, Rosé Pine, Everforest, Kanagawa, One Dark, Night Owl, Monokai Pro, GitHub, Ayu, Vitesse, and Synthwave '84. Pick one from the palette button in the top bar. Press <kbd>t</kbd> (no Shift) to switch between light and dark. In the hub, the theme follows the hub in both directions, and the picker lists the hub's themes in place of these.
