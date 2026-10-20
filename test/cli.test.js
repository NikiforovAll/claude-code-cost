const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveWindow, previousWindow, parseWindowValue, findServer, parseArgs, isCommand, matchSessions, main } = require('../lib/cli');
const { parseCustomRange } = require('../lib/costs');

function configDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cli-'));
  if (config) {
    fs.mkdirSync(path.join(dir, '.cost'));
    fs.writeFileSync(path.join(dir, '.cost', 'config.json'), JSON.stringify(config));
  }
  return dir;
}

function windowOf(flags, { config, env = {} } = {}) {
  const warnings = [];
  const w = resolveWindow(flags, { claudeDir: configDir(config), parseCustomRange, env, warn: (s) => warnings.push(s) });
  return { w, warnings };
}

describe('parseWindowValue', () => {
  it('reads presets and day counts', () => {
    assert.equal(parseWindowValue('today').range, 'today');
    assert.equal(parseWindowValue('24h').range, '24h');
    assert.equal(parseWindowValue('7d').range, 7);
    assert.equal(parseWindowValue('30').range, 30);
    assert.equal(parseWindowValue('365d').range, 365);
  });

  it('rejects all time, zero and more than a year', () => {
    for (const v of ['all', '0', '0d', '366d', '1000', 'week', '']) assert.equal(parseWindowValue(v), null, v);
  });
});

describe('resolveWindow', () => {
  it('defaults to 7 days', () => {
    const { w } = windowOf({});
    assert.equal(w.range, 7);
    assert.equal(w.query, 'range=7');
    assert.equal(w.source, 'default');
  });

  it('takes the flag over the env and the config', () => {
    const { w } = windowOf({ range: 'today' }, { config: { cli: { defaultRange: '30d' } }, env: { CLAUDE_COST_RANGE: '90d' } });
    assert.equal(w.range, 'today');
  });

  it('takes the env over the config', () => {
    const { w } = windowOf({}, { config: { cli: { defaultRange: '30d' } }, env: { CLAUDE_COST_RANGE: '90d' } });
    assert.equal(w.range, 90);
    assert.equal(w.source, 'CLAUDE_COST_RANGE');
  });

  it('reads cli.defaultRange from <config dir>/.cost/config.json', () => {
    const { w } = windowOf({}, { config: { cli: { defaultRange: '30d' } } });
    assert.equal(w.range, 30);
    assert.equal(w.source, 'cli.defaultRange');
  });

  it('skips a bad env or config value with a warning', () => {
    const { w, warnings } = windowOf({}, { config: { cli: { defaultRange: 'all' } }, env: { CLAUDE_COST_RANGE: 'soon' } });
    assert.equal(w.range, 7);
    assert.equal(warnings.length, 2);
  });

  it('fails on a bad flag', () => {
    assert.throws(() => windowOf({ range: '400d' }), /--range 400d/);
  });

  it('takes a from/to pair over --range', () => {
    const { w } = windowOf({ range: '7d', from: '2026-01-10', to: '2026-01-01' });
    assert.deepEqual(w.range, { from: '2026-01-01', to: '2026-01-10' });
    assert.equal(w.days, 10);
    assert.equal(w.query, 'from=2026-01-01&to=2026-01-10');
  });

  it('fails on half a pair, a bad date or more than a year', () => {
    assert.throws(() => windowOf({ from: '2026-01-01' }), /pair/);
    assert.throws(() => windowOf({ from: '2026-02-30', to: '2026-03-01' }), /pair/);
    assert.throws(() => windowOf({ from: '2024-01-01', to: '2025-06-01' }), /365 days/);
  });
});

describe('previousWindow', () => {
  const now = new Date(2026, 2, 3, 15);

  it('takes the days before n days that end today', () => {
    assert.deepEqual(previousWindow(parseWindowValue('7d'), now).range, { from: '2026-02-18', to: '2026-02-24' });
  });

  it('takes yesterday for today', () => {
    assert.deepEqual(previousWindow(parseWindowValue('today'), now).range, { from: '2026-03-02', to: '2026-03-02' });
  });

  it('shifts a from/to pair back by its length', () => {
    const { w } = windowOf({ from: '2026-01-01', to: '2026-01-10' });
    const prev = previousWindow(w, now);
    assert.deepEqual(prev.range, { from: '2025-12-22', to: '2025-12-31' });
    assert.equal(prev.query, 'from=2025-12-22&to=2025-12-31');
  });

  it('has no window before 24h', () => {
    assert.throws(() => previousWindow(parseWindowValue('24h'), now), /not 24h/);
  });
});

describe('matchSessions', () => {
  it('keeps sessions whose title has the text, in any case, and not the first prompt', () => {
    const d = {
      sessions: [
        { sessionId: 'a', customTitle: 'Rate-Limiter fix' },
        { sessionId: 'b', customTitle: null, firstPrompt: 'rate-limiter please' },
        { sessionId: 'c', customTitle: 'blob' },
      ],
    };
    assert.deepEqual(matchSessions(d, 'rate-LIMITER').sessions.map((s) => s.sessionId), ['a']);
  });

  it('refuses --match with no text before it reads anything', async () => {
    const errs = [];
    assert.equal(await main(['sessions', '--match'], { out: () => {}, err: (s) => errs.push(s) }), 1);
    assert.match(errs.join('\n'), /--match takes text/);
  });
});

describe('findServer', () => {
  function withServerFile(rec) {
    const dir = configDir();
    fs.mkdirSync(path.join(dir, '.cost'));
    fs.writeFileSync(path.join(dir, '.cost', 'server.json'), JSON.stringify(rec));
    return dir;
  }

  it('prefers COST_URL', () => {
    assert.equal(findServer(configDir(), { COST_URL: 'http://localhost:9/' }), 'http://localhost:9');
  });

  it('reads server.json when its pid is alive', () => {
    assert.equal(findServer(withServerFile({ pid: process.pid, port: 4321 }), {}), 'http://localhost:4321');
  });

  it('ignores server.json of a dead pid, and no file at all', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    assert.equal(findServer(withServerFile({ pid: dead, port: 4321 }), {}), null);
    assert.equal(findServer(configDir(), {}), null);
  });
});

describe('parseArgs and isCommand', () => {
  it('splits flags and positionals', () => {
    const { flags, positional } = parseArgs(['abc', '--range', '30d', '--json', '--top=3', 'def']);
    assert.deepEqual(positional, ['abc', 'def']);
    assert.deepEqual(flags, { range: '30d', json: true, top: '3' });
  });

  it('knows its commands and leaves server flags alone', () => {
    for (const c of ['overview', 'session', 'help', '--help']) assert.ok(isCommand(c), c);
    for (const c of [undefined, '--port', '--open', 'serve']) assert.ok(!isCommand(c), String(c));
  });
});
