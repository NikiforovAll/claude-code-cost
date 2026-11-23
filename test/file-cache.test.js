const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cache-'));
process.env.CLAUDE_CONFIG_DIR = cfg;
global.fetch = async () => { throw new Error('offline'); };
const c = require('../lib/costs');

const MODEL = 'claude-sonnet-4-20250514';
const ts = (s) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const usage = (out) => ({ input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 });
const turn = (s, id, out, tools = []) => ({
  type: 'assistant', timestamp: ts(s), requestId: `req_${id}`,
  message: { id: `msg_${id}`, model: MODEL, usage: usage(out), content: tools.map((name) => ({ type: 'tool_use', name, input: {} })) },
});

const sessionLines = [
  { type: 'custom-title', customTitle: 'Growing session' },
  turn(1, 'a', 50, ['Read']),
  turn(2, 'a', 50, ['Grep']),
  turn(3, 'b', 80),
  { type: 'system', subtype: 'compact_boundary', timestamp: ts(4), compactMetadata: { trigger: 'auto', preTokens: 5000, postTokens: 500 } },
  turn(5, 'c', 20, ['Edit']),
  { type: 'assistant', timestamp: ts(6), message: { model: MODEL, usage: usage(5), content: [] } },
];
const agentLines = [turn(7, 'x', 1), turn(8, 'x', 40, ['Bash']), turn(9, 'y', 3)];
const text = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

function writeSession(project, id, sessionText, agentText) {
  const dir = path.join(cfg, 'projects', project);
  fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), sessionText);
  fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-1.jsonl'), agentText);
  return { session: path.join(dir, `${id}.jsonl`), agent: path.join(dir, id, 'subagents', 'agent-1.jsonl') };
}

async function detail(id) {
  c.invalidateAllCache();
  const d = await c.getSessionDetailData(id);
  const a = await c.getAgentDetailData(id, 'agent-1');
  const { sessionId, projectPath, encodedProjectPath, ...rest } = d;
  return { session: rest, agent: a.messages };
}

describe('transcript file cache', () => {
  it('reads a file that grows in pieces, cut mid-line, the same as one full read', async () => {
    const full = { session: text(sessionLines), agent: text(agentLines) };
    writeSession('C--full', 'full', full.session, full.agent);
    const expected = await detail('full');

    const files = writeSession('C--grow', 'grow', '', '');
    for (const step of [0.13, 0.4, 0.41, 0.77, 1]) {
      for (const k of ['session', 'agent']) {
        const have = fs.statSync(files[k]).size;
        fs.appendFileSync(files[k], full[k].slice(have, Math.floor(full[k].length * step)));
      }
      await detail('grow');
    }
    assert.deepEqual(await detail('grow'), expected);
    assert.equal(expected.session.customTitle, 'Growing session');
    assert.deepEqual(expected.session.messages.find((m) => m.timestamp === ts(1)).tools, ['Read', 'Grep']);
    assert.ok(expected.session.messages.find((m) => m.timestamp === ts(5)).compaction);
    assert.deepEqual(expected.agent.map((m) => m.outputTokens), [40, 3]);
  });

  it('reads a file again from the start when it shrinks', async () => {
    const files = writeSession('C--shrink', 'shrink', text(sessionLines), text(agentLines));
    assert.equal((await detail('shrink')).session.messages.filter((m) => !m._subagent).length, 4);
    fs.writeFileSync(files.session, text(sessionLines.slice(0, 2)));
    assert.equal((await detail('shrink')).session.messages.filter((m) => !m._subagent).length, 1);
  });

  it('reads a file again from the start when another tool rewrites it', async () => {
    const outputs = async () => (await detail('rewrite')).session.messages.filter((m) => !m._subagent).map((m) => m.outputTokens);
    const files = writeSession('C--rewrite', 'rewrite', text([turn(1, 'a', 300)]), text(agentLines));
    assert.deepEqual(await outputs(), [300]);

    fs.writeFileSync(files.session, text([turn(1, 'a', 900)]));
    fs.utimesSync(files.session, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(await outputs(), [900], 'same size, new content');

    fs.writeFileSync(files.session, text([turn(1, 'z', 7), turn(2, 'b', 8), turn(3, 'c', 9)]));
    assert.deepEqual(await outputs(), [7, 8, 9], 'bigger, different content');
  });
});

after(() => fs.rmSync(cfg, { recursive: true, force: true }));
