---
name: cost
description: Read Claude Code costs — totals by day, model and project, the costliest sessions and subagents, one session's turns, and plan usage limits.
argument-hint: '[overview|insights|projects|sessions|agents|session|agent|limits] [flags]'
disable-model-invocation: true
---

# Cost

The skill is a thin wrapper over the `claude-code-cost` CLI. Find the command in this order:

1. The command your system prompt names for the cost CLI, when it names one.
2. When the Cost dashboard runs (for example in Claude Code Hub), it writes `<config dir>/.cost/server.json`. Read its `script` field, the path of the CLI, and run `node "<that path>"`. The config dir is `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Quote the path: on Windows it has backslashes. No file means no dashboard; go to step 3.
3. `claude-code-cost` on PATH.
4. `npx claude-code-cost`.

## Commands

| Command | What it prints |
|---|---|
| `overview` | Total cost, by model, by day and the top projects; `--compare` adds the window before |
| `insights` | Run rate, 5-hour blocks, subagent share, compactions, top tools |
| `projects` | Projects by cost |
| `sessions [<project>]` | Sessions by cost, with their ids; `--match <title>` |
| `agents` | Subagents by skill or agent type: runs, total, average |
| `session <id>` | One session: totals, subagents, costliest turns |
| `agent <session id> <agent id>` | One subagent of a session |
| `limits` | Plan usage limits: the 5-hour and weekly windows |

Most commands take `--range` (`today`, `24h`, `<n>d`) and `--json`. `help <command>` prints the flags; it matches the installed binary, so read it before you use a flag.

## Rules

- State the window with every number. The default is 7 days. `session` and `agent` take no `--range`: they cover the whole session, so state its first and last date.
- A list shows the top rows only. `--top <n>` shows more.
- The costs are estimates from the transcripts at list prices, not an invoice.
- The commands only read. They change nothing.
