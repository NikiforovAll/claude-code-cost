---
title: How costs are computed
description: Where every number in Claude Code Cost comes from, how it is priced, and what the estimate leaves out.
---

Claude Code Cost reads the transcripts that Claude Code writes on your disk. It counts the tokens in each turn and multiplies them by public list prices. The result is an estimate. It is not your bill.

## Source files

Claude Code writes one transcript per session. Claude Code Cost reads every `*.jsonl` file in each project folder:

```text
<config dir>/projects/<project>/<session id>.jsonl
```

The file name is the session id. The config dir is `~/.claude` unless you set another one (see [Configuration and CLI](/claude-code-cost/reference/configuration/)). With the default `~/.claude` profile, Claude Code Cost also scans `~/.config/claude/projects`. A custom config dir scans only its own `projects` folder.

When you pick a date range, Claude Code Cost skips each file that was last modified before the range starts. That file cannot hold turns inside the range.

Claude Code Cost looks for a `cwd` at the start of the first three transcripts in the folder and uses the last segment of that path. If none of them has a `cwd`, it decodes the encoded folder name. That decode is a best guess, because Claude Code writes both path separators and hyphens as `-` in the folder name.

## What counts as a turn

A transcript line is a billed turn only when it has `message.usage.input_tokens` (0 is a valid value) and a `timestamp`. Each turn gives four token counts:

| Field in `message.usage` | Shown as |
| --- | --- |
| `input_tokens` | Input |
| `output_tokens` | Output |
| `cache_creation_input_tokens` | Cache write (Cache Created) |
| `cache_read_input_tokens` | Cache read |

## Duplicate lines

Claude Code streams a reply and writes one line for each content block. All these lines belong to one API call. Claude Code Cost keys each turn by `message.id` plus `requestId` and counts the turn once:

- In the session transcript, the first line wins. Claude Code Cost merges the tool names from the other lines into it, so tool counts stay complete.
- In a subagent transcript, the line with the largest `output_tokens` wins. Those logs record usage as it stood when each block was written, so the first line can show only part of the reply.

A line with no `message.id` or no `requestId` is counted as is.

## Subagents and workflows

Subagent transcripts sit next to the session file:

```text
<project>/<session id>/subagents/agent-*.jsonl
<project>/<session id>/subagents/workflows/<workflow id>/agent-*.jsonl
```

A workflow that starts another workflow nests its agent logs one `workflows/<workflow id>/` level deeper. Claude Code Cost reads every level.

Claude Code Cost prices each agent log with the same rules and adds it to the session total. In the session detail, each agent shows as one row. It skips an agent log that has no priced turns. It ignores the `journal.jsonl` file of a workflow run.

## The pricing table

Prices come from LiteLLM's `model_prices_and_context_window.json` on GitHub. Claude Code Cost fetches the table when the server starts and keeps it for 6 hours. After that, the next request that needs prices fetches it again.

If the fetch fails, Claude Code Cost keeps the table it already has. If it has none, it uses a small bundled table with five models: Claude Sonnet 4, Claude Opus 4, Claude Haiku 4.5, Claude 3.5 Sonnet, and Claude 3.5 Haiku. A newer model is then not in the table and costs $0 (see below).

To see the prices that are loaded now, open `/api/pricing` on the dashboard's address, for example `http://localhost:3543/api/pricing`. It lists the entries whose name starts with `anthropic/` or `claude`.

The Refresh button and <kbd>R</kbd> clear the computed results and read the transcripts again. They do not fetch prices again. To get new prices before the 6 hours pass, restart the server.

## Model lookup

For each turn, Claude Code Cost looks up the model name in this order:

1. The exact name.
2. The name with the prefix `anthropic/`, then `claude-3-5-`, then `claude-3-`, then `claude-`.
3. A lowercase substring match in either direction.

If nothing matches, the turn costs $0.

## The formula

For one turn:

```text
cost = input        × input price
     + output       × output price
     + cache writes × cache-creation price
     + cache reads  × cache-read price
```

Two rules change this:

- **200K tier.** Claude Code Cost checks each token kind on its own. If a turn has more than 200,000 tokens of one kind and the model has an `*_above_200k_tokens` price, the tokens past 200,000 use that price. The first 200,000 use the base price.
- **Fast mode.** If `usage.speed` is `fast`, Claude Code Cost multiplies the turn cost by the model's `provider_specific_entry.fast` factor. The bundled table sets this to 6 for Claude Opus 4. A model with no factor uses 1.

If a transcript line has a `costUSD` value, Claude Code Cost uses that value as is and skips the formula.

### Worked example

The prices below are illustrative. They are the bundled Claude Sonnet 4 prices, per million tokens. Your loaded table can differ.

| Kind | Tokens | Price per 1M | Cost |
| --- | ---: | ---: | ---: |
| Input | 2,000 | $3.00 | $0.0060 |
| Output | 1,500 | $15.00 | $0.0225 |
| Cache write | 10,000 | $3.75 | $0.0375 |
| Cache read | 150,000 | $0.30 | $0.0450 |
| **Turn total** | | | **$0.1110** |

Now say the same turn read 250,000 tokens from cache. The first 200,000 cost $0.30 per million ($0.06). The other 50,000 cost the tier price of $0.60 per million ($0.03). The cache read line becomes $0.09.

## Compaction

When Claude Code compacts a conversation, the transcript records the boundary but not the usage of the summary call. Claude Code Cost estimates that call:

- Input: the whole pre-compaction context, priced as a cache read.
- Output: the post-compaction size.

The session detail shows this value as "estimate, not in total". It does not add it to any total.

The first turn after a compaction writes the cache again from the summary. The session detail shows that cache write as the re-warm cost. That cost is a real logged turn, so it is already in the total. If the turn has no real model name, Claude Code Cost gives both values no price at all (`null` in the API), so they do not read as free.

## Synthetic models

Claude Code writes some entries with a model name that starts with `<`, such as `<synthetic>`. These are not models you chose. Claude Code Cost leaves them out of Cost by Model. In the cost over time charts, it groups them as `other`, so each bar still adds up to the full total.

## Derived numbers

| Number | Where | Formula |
| --- | --- | --- |
| Cache Efficiency | Overview | cache reads ÷ (input + cache writes + cache reads) |
| Cache Savings | Insights | cache reads × (input price − cache-read price), per model |
| Cache hit % | Insights, Cache Savings card | cache reads ÷ (cache reads + cache writes) |

Cache Savings is what the cache reads would have cost as fresh input, minus what they cost as reads. In the worked example, 150,000 cache reads save 150,000 × ($3.00 − $0.30) per million, which is $0.405. Models with no input price or no cache-read price add nothing to it.

## What the numbers are not

- **Not an Anthropic invoice.** The numbers use public list prices. They do not include discounts, credits, taxes, or the price you pay.
- **Not your plan limits.** The percentages in the Plan usage dialog come from Claude. Claude Code Cost does not compute them, and its cost estimates do not feed them.
- **Not complete.** A model that is not in the pricing table counts as $0. The compaction summary call is only an estimate and is not in the total. Only turns that Claude Code writes to the transcripts count.

For how these numbers show in each view, see [Read the overview](/claude-code-cost/guides/overview/), [Trace a project to a message](/claude-code-cost/guides/sessions/), and [Watch 5-hour blocks and burn rate](/claude-code-cost/guides/insights/).
