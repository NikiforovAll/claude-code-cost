'use strict';

const fs = require('node:fs');
const path = require('node:path');
const costs = require('./costs');

// #region WINDOW

const DEFAULT_RANGE = '7d';
const LONG_PARSE_DAYS = 30;
// The dashboard's longest preset. The overview has no all-time window.
const MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_HINT = `today, 24h or <n>d up to ${MAX_DAYS}d`;

function parseWindowValue(raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'today') return { range: 'today', days: 1, label: 'Today' };
  if (v === '24h') return { range: '24h', days: 1, label: 'Last 24 hours' };
  const m = /^(\d{1,3})d?$/.exec(v);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > MAX_DAYS) return null;
  const n = Number(m[1]);
  return { range: n, days: n, label: n === 1 ? 'Today' : `Last ${n} days` };
}

function configRange(claudeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(claudeDir, '.cost', 'config.json'), 'utf8'))?.cli?.defaultRange;
  } catch {
    return undefined;
  }
}

function customWindow(from, to, days) {
  return { range: { from, to }, days, label: from === to ? from : `${from} – ${to}`, query: `from=${from}&to=${to}` };
}

// The same number of whole days, ending the day before `win` starts. The API has no rolling window
// that ends in the past, so 24h has no window before it.
function previousWindow(win, now = new Date()) {
  if (win.range === '24h') throw usageError('--compare needs today, <n>d or --from/--to, not 24h');
  const start = costs.resolveWindow(win.range, now).cutoff;
  const day = (delta) => costs.localDateStr(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta));
  return customWindow(day(-win.days), day(-1), win.days);
}

// The flag wins, then CLAUDE_COST_RANGE, then cli.defaultRange in <config dir>/.cost/config.json,
// then 7 days. A bad flag is an error; a bad env or config value is skipped with a warning, so a
// typo in a file does not break every command.
function resolveWindow(flags, { claudeDir, parseCustomRange, env = process.env, warn = console.error }) {
  if (flags.from !== undefined || flags.to !== undefined) {
    const custom = parseCustomRange({ from: flags.from, to: flags.to });
    if (!custom) throw usageError('--from and --to take local dates (YYYY-MM-DD) and come as a pair');
    const days = Math.round((Date.parse(custom.to) - Date.parse(custom.from)) / DAY_MS) + 1;
    if (days > MAX_DAYS) throw usageError(`--from/--to: at most ${MAX_DAYS} days`);
    return customWindow(custom.from, custom.to, days);
  }
  const sources = [
    [flags.range, '--range'],
    [env.CLAUDE_COST_RANGE, 'CLAUDE_COST_RANGE'],
    [configRange(claudeDir), 'cli.defaultRange'],
    [DEFAULT_RANGE, 'default'],
  ];
  for (const [raw, source] of sources) {
    if (raw === undefined || raw === null || raw === '') continue;
    const w = parseWindowValue(raw);
    if (w) return { ...w, source, query: `range=${w.range}` };
    if (source === '--range') throw usageError(`--range ${raw}: use ${WINDOW_HINT}`);
    warn(`${source}: "${raw}" is not a window (${WINDOW_HINT}); skipped`);
  }
}

// #endregion

// #region BACKEND

function serverFromFile(claudeDir) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(claudeDir, '.cost', 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(rec?.pid) || !Number.isInteger(rec?.port)) return null;
  try {
    process.kill(rec.pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return null;
  }
  return `http://localhost:${rec.port}`;
}

// No blind try of port 3543: it can belong to another config dir's server, and parsing the files
// gives the right answer, only slower.
function findServer(claudeDir, env = process.env) {
  if (env.COST_URL) return env.COST_URL.replace(/\/+$/, '');
  return serverFromFile(claudeDir);
}

const enc = encodeURIComponent;

const scoped = (route) => (p) => `${route}?${p.win.query}${p.project ? `&project=${enc(p.project)}` : ''}`;
const sliced = (base) => base && costs.withSessionSlices(base, null);

const ENDPOINTS = {
  overview: {
    path: scoped('/api/overview'),
    local: (c, p) => c.getOverviewData(p.win.range, p.project),
  },
  insights: {
    path: scoped('/api/insights'),
    local: (c, p) => c.getInsightsData(p.win.range, p.project),
  },
  projects: {
    path: (p) => `/api/projects?${p.win.query}`,
    local: (c, p) => c.getProjectsData(p.win.range),
  },
  sessions: {
    path: (p) => (p.project ? `/api/projects/${enc(p.project)}/sessions?${p.win.query}` : `/api/sessions?${p.win.query}`),
    local: (c, p) => (p.project ? c.getProjectSessionsData(p.project, p.win.range) : c.getAllSessionsData(p.win.range)),
  },
  agents: {
    path: scoped('/api/agents'),
    local: (c, p) => c.getAgentsData(p.win.range, p.project),
  },
  session: {
    path: (p) => `/api/sessions/${enc(p.session)}`,
    local: async (c, p) => sliced(await c.getSessionDetailData(p.session)),
  },
  agent: {
    path: (p) => `/api/sessions/${enc(p.session)}/agents/${enc(p.agent)}`,
    local: async (c, p) => sliced(await c.getAgentDetailData(p.session, p.agent)),
  },
  limits: {
    path: (p) => `/api/usage-limits${p.refresh ? '?refresh=1' : ''}`,
    local: (c, p) => c.loadUsage(p.refresh),
    did: 'probed claude',
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchServer(base, url) {
  const res = await fetch(base + url, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, body?.error || `HTTP ${res.status}`);
  return body;
}

// Asks the server of this config dir; with none, or one that does not answer, parses the files in
// this process. Notes go to stderr, so --json output stays clean.
async function query(name, params, ctx) {
  const ep = ENDPOINTS[name];
  const base = ctx.server;
  if (base) {
    try {
      return await fetchServer(base, ep.path(params));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      ctx.note(`cost server at ${base} did not answer (${err.cause?.code || err.message}); parsing files`);
    }
  }
  const win = params.win;
  if (win && win.days > LONG_PARSE_DAYS) {
    ctx.note(`parsing ${win.days} days of transcripts, this can take a while`);
  }
  const started = Date.now();
  const data = await ep.local(costs, params);
  ctx.note(`no cost server: ${ep.did || 'parsed files'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return data;
}

// #endregion

// #region FORMAT

const WIDTH = 54;

function usd(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`;
}

function pct(part, total) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
}

function tokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const shortModel = (m) => String(m || '?').replace(/^claude-/, '');

function localStamp(iso, withDate = true) {
  if (!iso) return '?';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${costs.localDateStr(d)} ${time}` : time;
}

function span(first, last) {
  if (!first) return '?';
  const sameDay = costs.localDateStr(new Date(first)) === costs.localDateStr(new Date(last));
  return `${localStamp(first)} – ${localStamp(last, !sameDay)}`;
}

function dupNames(list) {
  const seen = new Set();
  const dups = new Set();
  for (const p of list) (seen.has(p.name) ? dups : seen).add(p.name);
  return dups;
}

const headline = (win, s) => `${win.label} · ${usd(s.totalCost)} · ${s.totalSessions} sessions`;

function sessionTitle(s) {
  return clip(s.customTitle || s.firstPrompt || '(untitled)', 40);
}

const NAME_WIDTH = 30;

function row(left, cost, extra = '') {
  return `  ${clip(left, NAME_WIDTH).padEnd(NAME_WIDTH)} ${usd(cost).padStart(9)}${extra ? `  ${extra}` : ''}`;
}

function bucketLabel(key, bucket) {
  return bucket === 'hour' ? `${key.slice(0, 10)} ${key.slice(11)}:00` : key;
}

function topTurns(messages, top) {
  return messages
    .filter((m) => !m._subagent)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, top)
    .map((m) => {
      const tools = (m.tools || []).slice(0, 3).join(', ');
      return `  #${String(m.index).padEnd(4)} ${usd(m.cost).padStart(7)}  ${localStamp(m.timestamp, false)}  ${clip(tools, WIDTH - 24)}`;
    });
}

function section(lines, title, items, toRow) {
  if (items.length) lines.push('', title, ...items.map(toRow));
}

const FORMAT = {
  overview(d, { win, top }) {
    const s = d.summary;
    const lines = [headline(win, s)];
    if (s.todayCost !== null && s.todayCost !== undefined && win.range !== 'today') lines.push(`Today ${usd(s.todayCost)}`);
    lines.push(`Tokens ${tokens(s.totalTokens)} · cache reads ${pct(s.totalCacheRead, s.totalTokens)}`);
    section(lines, 'By model', (d.modelDistribution || []).slice(0, top), (m) => row(shortModel(m.model), m.cost, pct(m.cost, s.totalCost)));
    const bucket = d.costSeries?.bucket;
    const points = (d.costSeries?.points || []).filter((p) => p.cost > 0);
    const bucketRow = (p) => row(bucketLabel(p.key, bucket), p.cost);
    if (points.length <= 14) section(lines, `By ${bucket}`, points, bucketRow);
    else section(lines, `Costliest ${bucket}s`, [...points].sort((a, b) => b.cost - a.cost).slice(0, top), bucketRow);
    section(lines, 'Top projects', (d.projects || []).slice(0, top), (p) => row(p.name, p.totalCost, `${p.sessionCount} sess`));
    return lines;
  },

  insights(d, { win, top }) {
    const lines = [win.label];
    if (d.runRate) lines.push(`Run rate ${usd(d.runRate.dailyAvg)}/day · ${usd(d.runRate.projectedMonthly)}/month (${d.runRate.days} days)`);
    if (d.cacheSavings) lines.push(`Cache saved ${usd(d.cacheSavings)}`);
    const sa = d.subagents;
    if (sa) {
      const total = sa.mainCost + sa.subagentCost;
      lines.push(`Subagents ${usd(sa.subagentCost)} (${pct(sa.subagentCost, total)}) · workflows ${usd(sa.workflowCost)} in ${sa.workflowRuns} run${sa.workflowRuns === 1 ? '' : 's'}`);
    }
    const block = (d.blocks || []).find((b) => b.active);
    if (block) lines.push(`Current 5h block ${usd(block.cost)} since ${localStamp(block.start, false)}`);
    const blocks = [...(d.blocks || [])].sort((a, b) => b.cost - a.cost).slice(0, top);
    section(lines, 'Costliest 5h blocks', blocks, (b) => row(localStamp(b.start), b.cost, `${b.messageCount} turns`));
    if (d.tools?.length) lines.push('', `Top tools: ${d.tools.slice(0, top).map((t) => `${t.name} ${t.count}`).join(', ')}`);
    return lines;
  },

  projects(all, { win, top }) {
    const list = all.filter((p) => p.totalCost > 0);
    const lines = [`${win.label} · ${list.length} projects · ${usd(list.reduce((a, p) => a + p.totalCost, 0))}`];
    const dups = dupNames(list);
    for (const p of list.slice(0, top)) {
      lines.push(row(p.name, p.totalCost, `${p.sessionCount} sess`));
      if (dups.has(p.name)) lines.push(`    ${p.encodedPath}`);
    }
    return lines;
  },

  sessions(d, { win, top, project }) {
    const list = [...(d.sessions || [])].sort((a, b) => b.totalCost - a.totalCost);
    const total = list.reduce((a, s) => a + s.totalCost, 0);
    const lines = [`${project ? project.name : 'All projects'} · ${win.label} · ${list.length} sessions · ${usd(total)}`];
    for (const s of list.slice(0, top)) {
      lines.push(`${usd(s.totalCost).padStart(9)}  ${sessionTitle(s)}`);
      const where = s.projectName ? `${clip(s.projectName, NAME_WIDTH)} · ` : '';
      lines.push(`${' '.repeat(11)}${where}${localStamp(s.firstTimestamp).slice(0, 10)} · ${s.durationMinutes} min · ${s.messageCount} turns`);
      lines.push(`${' '.repeat(11)}${s.sessionId}`);
    }
    return lines;
  },

  agents(d, { win, top, project }) {
    const list = d.agents || [];
    const total = list.reduce((a, g) => a + g.totalCost, 0);
    const runs = list.reduce((a, g) => a + g.runs, 0);
    const lines = [`${project ? project.name : 'All projects'} · ${win.label} · ${runs} subagent runs · ${usd(total)}`];
    for (const g of list.slice(0, top)) {
      const name = g.kind === 'skill' ? `/${g.name}` : g.kind === 'workflow' ? `workflow · ${g.name}` : g.name;
      lines.push(row(name, g.totalCost, `${g.runs} run${g.runs === 1 ? '' : 's'} · avg ${usd(g.avgCost)}`));
      const c = g.costliest;
      lines.push(`    costliest ${usd(c.cost)} · ${clip(c.description, WIDTH - 20)}`);
      lines.push(`    ${c.sessionId} ${c.agentId}`);
    }
    return lines;
  },

  session(d, { top }) {
    const turns = d.messages.filter((m) => !m._subagent);
    const agents = d.messages.filter((m) => m._subagent).sort((a, b) => b.cost - a.cost);
    const lines = [
      sessionTitle(d),
      `${d.projectPath} · ${span(d.firstTimestamp, d.lastTimestamp)}`,
      `${usd(d.totalCost)} · ${turns.length} turns · ${(d.models || []).map(shortModel).join(', ')}`,
      `Tokens in ${tokens(d.inputTokens)} · out ${tokens(d.outputTokens)} · cache write ${tokens(d.cacheCreationTokens)} · read ${tokens(d.cacheReadTokens)}`,
    ];
    if (d.compactions?.count) lines.push(`Compactions ${d.compactions.count} (${d.compactions.auto} auto) · ${usd(d.compactions.totalCost)}`);
    if (agents.length) {
      lines.push('', `Subagents ${agents.length} · ${usd(agents.reduce((a, m) => a + m.cost, 0))}`);
      for (const m of agents.slice(0, top)) {
        const sa = m._subagent;
        const what = `${sa.workflowId ? 'workflow' : sa.agentType || 'agent'} · ${sa.description || ''}`;
        lines.push(`  ${usd(m.cost).padStart(7)}  ${clip(what, WIDTH - 11)}`);
        if (!sa.workflowId) lines.push(`           ${sa.agentId}`);
      }
    }
    section(lines, 'Costliest turns', topTurns(turns, top), (t) => t);
    return lines;
  },

  agent(d, { top }) {
    const lines = [
      `${d.agentType || 'agent'} · ${clip(d.description, 40)}`,
      `in ${clip(d.sessionTitle, 30)} (${d.projectPath})`,
      `${usd(d.totalCost)} · ${d.messages.length} turns · ${span(d.firstTimestamp, d.lastTimestamp)} · ${(d.models || []).map(shortModel).join(', ')}`,
    ];
    section(lines, 'Costliest turns', topTurns(d.messages, top), (t) => t);
    return lines;
  },

  limits(d) {
    const limitRow = (label, percent, suffix = '') => `  ${clip(label, 24).padEnd(24)} ${String(Math.round(percent || 0)).padStart(3)}%${suffix}`;
    const lines = [d.subscription ? `Plan: ${d.subscription}` : 'Plan usage'];
    for (const w of d.windows || []) {
      const reset = w.resetsAt ? ` · resets ${localStamp(typeof w.resetsAt === 'number' && w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt)}` : '';
      lines.push(limitRow(w.label, w.percent, reset));
    }
    if (d.spend?.enabled) lines.push(limitRow('Extra usage', d.spend.percent));
    return lines;
  },
};

function change(now, before) {
  const d = now - before;
  const sign = d < 0 ? '-' : '+';
  let rel = '';
  if (before > 0) rel = ` (${sign}${pct(Math.abs(d), before)})`;
  else if (now > 0) rel = ' (new)';
  return `${sign}${usd(Math.abs(d))}${rel}`;
}

// Rows of both windows by key, biggest change first, so a model or project that stopped shows too.
function diffRows(cur, prev, key, cost, top) {
  const rows = new Map();
  for (const [list, side] of [[cur, 'now'], [prev, 'before']]) {
    for (const x of list || []) {
      const k = key(x);
      if (!rows.has(k)) rows.set(k, { x, now: 0, before: 0 });
      rows.get(k)[side] += cost(x);
    }
  }
  return [...rows.values()].sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before)).slice(0, top);
}

const diffTitle = (title) => `${title.padEnd(NAME_WIDTH + 2)} ${'now'.padStart(9)}  ${'before'.padStart(9)}  change`;
const diffRow = (name, r) => row(name, r.now, `${usd(r.before).padStart(9)}  ${change(r.now, r.before)}`);

const COMPARE = {
  overview({ current, previous }, { win, before, top }) {
    const c = current.summary;
    const p = previous.summary;
    const lines = [headline(win, c), headline(before, p), `Change ${change(c.totalCost, p.totalCost)}`];
    const models = diffRows(current.modelDistribution, previous.modelDistribution, (m) => m.model, (m) => m.cost, top);
    section(lines, diffTitle('By model'), models, (r) => diffRow(shortModel(r.x.model), r));
    const projects = diffRows(current.projects, previous.projects, (p) => p.encodedPath, (p) => p.totalCost, top);
    const dups = dupNames(projects.map((r) => r.x));
    section(lines, diffTitle('Projects'), projects, (r) => diffRow(r.x.name, r) + (dups.has(r.x.name) ? `\n    ${r.x.encodedPath}` : ''));
    return lines;
  },
};

// #endregion

// #region COMMANDS

const BIN = 'claude-code-cost';

const WINDOW_FLAGS = {
  '--range <r>': WINDOW_HINT,
  '--from <date>': 'Window start, YYYY-MM-DD (needs --to)',
  '--to <date>': 'Window end, YYYY-MM-DD',
};
const COMMON_FLAGS = {
  '--top <n>': 'Rows per list (default 5)',
  '--json': 'Print the API response as JSON',
};

const SCOPED_FLAGS = { ...WINDOW_FLAGS, '--project <name>': 'One project (name or encoded dir)', ...COMMON_FLAGS };

const COMMANDS = {
  overview: {
    summary: 'Total cost, by model, by day and top projects; --compare to the window before',
    usage: `${BIN} overview [--range <r>] [--project <name>] [--compare] [--json]`,
    flags: { ...SCOPED_FLAGS, '--compare': 'Also the window before it, and the change' },
    notes: 'The window before has as many days and ends the day before. Today counts so far.\n--compare also parses the window before.',
    examples: [`${BIN} overview --range today`, `${BIN} overview --range 30d --project claude-code-hub`, `${BIN} overview --range 7d --compare`],
    window: true,
    project: true,
  },
  insights: {
    summary: 'Run rate, 5-hour blocks, subagent share, top tools',
    usage: `${BIN} insights [--range <r>] [--project <name>] [--json]`,
    flags: SCOPED_FLAGS,
    window: true,
    project: true,
  },
  projects: {
    summary: 'Projects by cost',
    usage: `${BIN} projects [--range <r>] [--json]`,
    flags: { ...WINDOW_FLAGS, ...COMMON_FLAGS },
    window: true,
  },
  sessions: {
    summary: 'Sessions by cost, with their ids: all projects or one',
    usage: `${BIN} sessions [<project>] [--range <r>] [--json]`,
    flags: { '<project>': 'Project name, or the encoded dir from projects --json', ...WINDOW_FLAGS, ...COMMON_FLAGS },
    examples: [`${BIN} sessions --range 30d --top 10`, `${BIN} sessions claude-code-hub --range 30d`],
    window: true,
    project: true,
    optionalArgs: ['project'],
  },
  agents: {
    summary: 'Subagents by skill or agent type: runs, total, average',
    usage: `${BIN} agents [--range <r>] [--project <name>] [--json]`,
    flags: SCOPED_FLAGS,
    notes: `A subagent started by a skill groups under /<skill>. Each row names its costliest run; open it with ${BIN} agent <session id> <agent id>.`,
    examples: [`${BIN} agents --range 30d`, `${BIN} agents --project claude-code-hub --top 10`],
    window: true,
    project: true,
  },
  session: {
    summary: 'One session: totals, subagents, costliest turns',
    usage: `${BIN} session <id> [--json]`,
    flags: { '<id>': 'Full session id', ...COMMON_FLAGS },
    notes: 'Covers the whole session; --range does not apply. Find an id with sessions, or claude-code-kanban session search.',
    examples: [`${BIN} session 3fa9c1d2-…`],
    args: ['session'],
    notFound: 'Session not found',
  },
  agent: {
    summary: 'One subagent of a session: totals, costliest turns',
    usage: `${BIN} agent <session id> <agent id> [--json]`,
    flags: { '<agent id>': 'agent-… id, as session prints it', ...COMMON_FLAGS },
    args: ['session', 'agent'],
    notFound: 'Subagent not found',
  },
  limits: {
    summary: 'Plan usage limits (5-hour and weekly windows)',
    usage: `${BIN} limits [--refresh] [--json]`,
    flags: { '--refresh': 'Probe again instead of using the 5-minute cache', '--json': COMMON_FLAGS['--json'] },
    notes: 'Probes the claude CLI: a few seconds without a server.',
  },
};

const BOOLEAN_FLAGS = new Set(['--json', '--refresh', '--compare', '--help', '-h']);
const HELP = new Set(['help', '--help', '-h']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.replace(/^-+/, '');
    if (BOOLEAN_FLAGS.has(name)) flags[key] = true;
    else if (eq !== -1) flags[key] = a.slice(eq + 1);
    else flags[key] = args[++i];
  }
  return { flags, positional };
}

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function topHelp() {
  const names = Object.keys(COMMANDS);
  const w = Math.max(...names.map((n) => n.length));
  return [
    `${BIN} — Claude Code costs from the command line`,
    '',
    `Usage: ${BIN} <command> [flags]`,
    `       ${BIN} [--port <n>] [--dir <config dir>] [--open]   start the dashboard`,
    '',
    'Commands:',
    ...names.map((n) => `  ${n.padEnd(w)}  ${COMMANDS[n].summary}`),
    '',
    `Window: --range, else CLAUDE_COST_RANGE, else cli.defaultRange in`,
    '<config dir>/.cost/config.json, else 7d.',
    'Asks the running dashboard of the config dir (COST_URL, else',
    '<config dir>/.cost/server.json); with none, parses the transcripts.',
    `--dir <config dir> picks the config dir. Details: ${BIN} help <command>`,
  ].join('\n');
}

function leafHelp(name) {
  const c = COMMANDS[name];
  const lines = [c.summary, '', `Usage: ${c.usage}`];
  const flags = Object.entries(c.flags || {});
  if (flags.length) {
    const w = Math.max(...flags.map(([f]) => f.length));
    lines.push('', 'Flags:', ...flags.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`));
  }
  if (c.notes) lines.push('', c.notes);
  if (c.examples?.length) lines.push('', 'Examples:', ...c.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

function isCommand(arg) {
  return HELP.has(arg) || Object.hasOwn(COMMANDS, arg || '');
}

function resolveProject(list, raw) {
  const exact = list.find((p) => p.encodedPath === raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  const named = list.filter((p) => p.name.toLowerCase() === lower);
  const hits = named.length ? named : list.filter((p) => p.name.toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw usageError(`No project matches "${raw}" in this window. Try a wider --range, or ${BIN} projects`);
  throw usageError(`"${raw}" matches ${hits.length} projects; pass the encoded dir:\n${hits.map((p) => `  ${p.name}  ${p.encodedPath}`).join('\n')}`);
}

async function main(args, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  // The data layer logs pricing fetches with console.log; stdout is for the answer.
  console.log = () => {};
  const [name, ...rest] = args;
  if (HELP.has(name)) {
    out(rest[0] && Object.hasOwn(COMMANDS, rest[0]) ? leafHelp(rest[0]) : topHelp());
    return 0;
  }
  const cmd = COMMANDS[name];
  const { flags, positional } = parseArgs(rest);
  if (flags.help || flags.h) {
    out(leafHelp(name));
    return 0;
  }
  if ((cmd.args || []).length > positional.length) {
    err(leafHelp(name));
    return 1;
  }
  try {
    const top = flags.top === undefined ? 5 : Number.parseInt(flags.top, 10);
    if (!Number.isInteger(top) || top < 1) throw usageError('--top takes a positive number');
    const { CLAUDE_DIR, parseCustomRange } = costs;
    const ctx = { server: findServer(CLAUDE_DIR), note: (s) => err(`(${s})`) };
    const params = { refresh: flags.refresh === true };
    [...(cmd.args || []), ...(cmd.optionalArgs || [])].forEach((a, i) => {
      params[a] = positional[i];
    });
    if (params.agent && !params.agent.startsWith('agent-')) params.agent = `agent-${params.agent}`;
    if (cmd.window) params.win = resolveWindow(flags, { claudeDir: CLAUDE_DIR, parseCustomRange, warn: err });
    const view = { win: params.win, top };

    const raw = params.project ?? flags.project;
    if (cmd.project && raw) {
      if (typeof raw !== 'string') throw usageError('--project takes a project name');
      const list = await query('projects', { win: params.win }, ctx);
      view.project = resolveProject(list || [], raw);
      params.project = view.project.encodedPath;
    }

    const compare = flags.compare && COMPARE[name];
    let data;
    if (compare) {
      view.before = previousWindow(params.win);
      const [current, previous] = await Promise.all([query(name, params, ctx), query(name, { ...params, win: view.before }, ctx)]);
      data = current && previous && { current, previous, previousWindow: view.before.range };
    } else {
      data = await query(name, params, ctx);
    }
    if (!data) {
      err(cmd.notFound || 'No data');
      return 1;
    }
    if (flags.json) out(JSON.stringify(data, null, 2));
    else out((compare || FORMAT[name])(data, view).join('\n'));
    return 0;
  } catch (e) {
    err(e.usage ? e.message : `Error: ${e.message}`);
    return 1;
  }
}

// #endregion

module.exports = { isCommand, main, resolveWindow, previousWindow, parseWindowValue, findServer, parseArgs };
