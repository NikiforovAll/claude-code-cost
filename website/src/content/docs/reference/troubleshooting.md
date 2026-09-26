---
title: Troubleshooting
description: Causes and fixes for numbers that look wrong, stale, or missing in Claude Code Cost.
---

## The dashboard is not on port 3543

If port 3543 is in use, the server logs `Port 3543 in use, trying random port...` and listens on a random free port. The startup banner shows the real address:

```text
Claude Code Cost Dashboard running at http://localhost:<port>
```

Open that address, or pick a free port yourself:

```bash
npx claude-code-cost --port 3600
```

See [Configuration and CLI](/claude-code-cost/reference/configuration/) for all flags.

## No data shows

Check these causes in order:

- **Wrong config dir.** The server reads transcripts from `<config dir>/projects`. With the default config dir, it also reads `~/.config/claude/projects`. The config dir is `--dir`, else `CLAUDE_CONFIG_DIR`, else `CLAUDE_DIR`, else `~/.claude`. If you run Claude Code with a custom config dir, start the dashboard with the same one: `npx claude-code-cost --dir ~/.claude-work`.
- **The range is too short.** The default range is 3 Days. A transcript file that was last changed before the range starts is skipped. Choose a longer range, such as 30 Days or 1 Year.
- **A project scope is still set.** With a scope, Overview shows `No usage for <project>` when that project has no sessions in the range. Click the x on the scope chip in the top bar to clear it.

See [Choose a date range and project scope](/claude-code-cost/guides/ranges-and-scope/).

## A model costs $0

A model that is not in the price list costs $0. The server looks up the model by its exact name, then with the prefixes `anthropic/`, `claude-3-5-`, `claude-3-`, and `claude-`, then by a partial name match. If all of these fail, the turn has no price.

To see which models have prices, open `/api/pricing` on the dashboard address, for example `http://localhost:3543/api/pricing`.

Prices come from the LiteLLM price list on GitHub. If the server cannot get that list, it uses a small offline table with only Sonnet 4, Opus 4, Haiku 4.5, Claude 3.5 Sonnet, and Claude 3.5 Haiku. Newer models then cost $0 until the server can get the list. The server fetches the list at startup and again at most every 6 hours. The refresh button does not fetch prices again, so restart the server after the network comes back.

## Totals differ from the Anthropic bill or console

The numbers are estimates, not a bill. Claude Code Cost multiplies the token counts in your local transcripts by public list prices. The totals can differ from what Anthropic charges because:

- It uses list prices. Discounts, plan pricing, and credits are not included.
- The compaction summary call is not in the totals. The transcript does not log its usage. Session detail shows an estimate for it, marked "estimate, not in total".
- Models with no price count as $0.

See [How costs are computed](/claude-code-cost/how-costs-are-computed/).

## Session detail shows a larger total than the sessions list

This is expected. The sessions list counts only the messages inside the selected range. Session detail always shows the whole session, and its totals are labeled "all time". When only part of the session is in the range, a note under the totals shows the in-range and today amounts, so you can compare them with the list.

## Active 5h Block shows "no live window data"

The active block needs live rate limit data from the Claude Code Kanban plugin statusline. The server reads it from `<config dir>/.cck/context-status`. Without it, no block is active, and the card shows "no live window data". Install the plugin and its statusline for the same config dir. Past blocks still show in the 5-Hour Billing Blocks table.

## Plan usage fails or is unavailable

Plan usage asks the local `claude` CLI for your plan limits. When the call fails, `/api/usage-limits` returns 503 and the dialog shows `Could not read plan usage`. Common causes:

- **The CLI is not found.** The server runs `claude` (`claude.exe` on Windows) from your `PATH`. Set `CLAUDE_BIN` to the full path of the executable.
- **The session does not have a plan.** Plan usage is not available for API key, Bedrock, and Vertex sessions.
- **The call timed out.** The server stops waiting after 60 seconds.

Each check starts a CLI process that runs no model turn, but it runs the config dir's `SessionStart` hooks. The server keeps the result for 5 minutes.

## Data looks stale

Press <kbd>R</kbd> or click Refresh. This clears the server and browser caches and loads the current view again.

Auto-refresh loads the view again only when its data is older than 5 minutes and the app is visible. Inside Claude Code Hub, it refreshes only while Claude Code Cost is the active app.

## Another device cannot connect

By default the server listens only on `127.0.0.1`, so other devices cannot connect. To reach it from another machine, start it with a host and an allowlist:

```bash
npx claude-code-cost --host 0.0.0.0 --allowed-hosts=<your-hostname>
```

Do this only on a network you trust. The dashboard has no authentication.

## A request gets 403 Forbidden

A 403 means the `Host` header is not a loopback address and is not in `--allowed-hosts`. This check blocks DNS rebinding attacks. It happens, for example, after `--host 0.0.0.0` without `--allowed-hosts`, or when you open the dashboard by a hostname that is not loopback. Add that name to `--allowed-hosts` or to the `ALLOWED_HOSTS` environment variable.

## The Weekly Cost chart is missing

Insights shows Weekly Cost only when the data has usage in 3 or more weeks. Weeks start on Monday. Choose a range long enough to include 3 weeks with usage, such as 30 Days.

## The Today card is missing

The Today card shows only when the range includes today. A custom range that ends before today hides it.
