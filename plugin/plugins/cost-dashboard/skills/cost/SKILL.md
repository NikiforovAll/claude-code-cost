---
name: cost
description: Answer a question about Claude Code costs — totals by day, model and project, the costliest sessions and subagents, plan usage limits.
argument-hint: '[question]'
disable-model-invocation: true
---

# Cost

Answer the user's cost question with the `claude-code-cost` CLI. With no question, run `overview`.

## Find the CLI

Use the first that exists:

1. The command your system prompt names for the cost CLI.
2. When the Cost dashboard runs (for example in Claude Code Hub), it writes `<config dir>/.cost/server.json`. Read its `script` field, the path of the CLI, and run `node "<that path>"`. The config dir is `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Quote the path: on Windows it has backslashes.
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

Most commands take `--range` (`today`, `24h`, `<n>d`) and `--json`. `help <command>` prints the flags of the installed binary: read it before you use a flag.

## Answer

- State the window with every number. The default is 7 days. `session` and `agent` cover the whole session: state its first and last date.
- A list shows the top rows. `--top <n>` shows more.
- Call the costs estimates: they come from the transcripts at list prices.
