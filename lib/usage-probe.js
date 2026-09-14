'use strict';

// Plan rate limits live behind a control request, not on disk: the statusline payload the cck
// plugin spies only ever carries five_hour/seven_day/spend_limit, so per-model windows (the
// "weekly_scoped" rows) are invisible to a file reader. `claude -p` speaks the stream-json control
// protocol, and its get_usage subtype answers with the same data /usage renders.
//
// The call runs no model turn, and total_cost_usd comes back 0. It still spawns a full CLI process
// and fires that config dir's SessionStart hooks, so callers must cache rather than poll.

const { spawn } = require('child_process');

// The answer is one HTTPS call plus a scan of every transcript touched in the last seven days.
const PROBE_TIMEOUT_MS = 60000;

function resolveBin() {
  return process.env.CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude');
}

function probeUsage({ claudeDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveBin(),
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ...(claudeDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}),
        },
      },
    );

    let settled = false;
    let buf = '';
    let stderr = '';

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('get_usage timed out')), PROBE_TIMEOUT_MS);

    child.on('error', (err) => finish(err));
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type !== 'control_response') continue;
        const r = msg.response;
        if (r?.subtype === 'error') {
          finish(new Error(r.error || 'get_usage failed'));
          return;
        }
        finish(null, r?.response ?? null);
        return;
      }
    });

    child.on('exit', (code) => {
      finish(new Error(`claude exited ${code} before answering${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'cost_usage_1',
        request: { subtype: 'get_usage' },
      })}\n`,
    );
    child.stdin.end();
  });
}

// The response shape is explicitly experimental, so normalize to what the dashboard draws and
// keep every window the CLI reports rather than naming the buckets this build happens to know.
//
// The order here is the render order: the per-model week, which is usually the binding one, then
// the all-models roll-up, then the session. Sorting by percent instead would reshuffle the rows
// between reads, so the one you were reading moves as you look.
const KINDS = [
  ['weekly_scoped', 'Week'],
  ['weekly_all', 'Week · all models'],
  ['weekly_oauth_apps', 'Week · apps'],
  ['session', 'Session'],
];
const KIND_LABELS = Object.fromEntries(KINDS);
const KIND_RANK = Object.fromEntries(KINDS.map(([kind], i) => [kind, i]));

// The CLI reports 'normal' right up to the cap, so a window only ever looks urgent if we say so.
// The returned names are the dashboard's own pace vocabulary, so the renderer writes `pace-${sev}`
// with nothing to translate.
function severityOf(reported, percent) {
  if (percent >= 90 || reported === 'critical') return 'hot';
  if (percent >= 70 || (reported && reported !== 'normal')) return 'warn';
  return 'ok';
}

function usageRow(label, percent, { severity, resetsAt, binding, rank } = {}) {
  return {
    label,
    percent,
    severity: severityOf(severity, percent),
    resetsAt: resetsAt || null,
    binding: binding === true,
    rank: rank ?? KINDS.length,
  };
}

function normalizeUsage(raw) {
  if (!raw) return null;
  const rl = raw.rate_limits;
  const rows = [];

  if (Array.isArray(rl?.limits)) {
    for (const l of rl.limits) {
      if (typeof l?.percent !== 'number') continue;
      const model = l.scope?.model?.display_name || null;
      const base = KIND_LABELS[l.kind] || l.kind;
      rows.push(
        usageRow(model ? `${base} · ${model}` : base, l.percent, {
          severity: l.severity,
          resetsAt: l.resets_at,
          binding: l.is_active,
          rank: KIND_RANK[l.kind],
        }),
      );
    }
  }

  // Older builds answer with the named windows only.
  if (!rows.length && rl) {
    for (const [key, label, rank] of [
      ['seven_day_opus', 'Week · Opus', KIND_RANK.weekly_scoped],
      ['seven_day_sonnet', 'Week · Sonnet', KIND_RANK.weekly_scoped],
      ['seven_day', 'Week · all models', KIND_RANK.weekly_all],
      ['five_hour', 'Session', KIND_RANK.session],
    ]) {
      const w = rl[key];
      if (typeof w?.utilization !== 'number') continue;
      rows.push(usageRow(label, w.utilization, { resetsAt: w.resets_at, rank }));
    }
  }

  const spend = rl?.spend
    ? {
        enabled: rl.spend.enabled === true,
        percent: typeof rl.spend.percent === 'number' ? rl.spend.percent : null,
        severity: severityOf(rl.spend.severity, rl.spend.percent || 0),
        disabledReason: rl.spend.disabled_reason || null,
      }
    : null;

  return {
    subscription: raw.subscription_type || null,
    windows: rows
      .sort((a, b) => a.rank - b.rank || b.percent - a.percent)
      .map(({ rank, ...row }) => row),
    spend,
    behaviors: raw.behaviors || null,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { probeUsage, normalizeUsage };
