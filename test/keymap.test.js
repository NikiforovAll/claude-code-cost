const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const pairs = /^const SHORTCUT_PAIRS = [\s\S]*?^\];/m.exec(src)[0];
const MAC_KEYS = /^const MAC_KEYS = .*;$/m.exec(src)[0];

// The hub's labels, as hub.keyLabel gives them after welcome. Empty: the hub has not answered.
let hubLabels = {};
// The page's own helpers, with the platform passed in the way the page's IS_MAC default does.
const page = vm.runInNewContext(
  `${MAC_KEYS}\nconst EMPTY_GROUP = { title: '', rows: [] };\n${fn('helpKeys')}\n${fn('buildHelpShortcuts')}\n${pairs}\n({ helpKeys, buildHelpShortcuts, SHORTCUT_PAIRS })`,
  { IS_MAC: false, esc: String, hub: { keyLabel: (a) => hubLabels[[a].flat().join()] ?? null } },
);
const { SHORTCUT_PAIRS } = page;
// Arrays from the vm context have another prototype, so copy them for deepEqual.
const helpKeys = (r, mac) => [...page.helpKeys(r, mac)];
const HUB_ACTIONS = ['hub.projectPicker', 'hub.configDirPicker', 'hub.appLauncher', 'hub.prevApp', 'hub.nextApp', 'hub.appByNumber'];

const rows = SHORTCUT_PAIRS.flat().flatMap((g) => g.rows);
const row = (label) => rows.find((r) => r.label === label);
const WIN = false;
const MAC = true;

describe('help dialog keys', () => {
  it('Windows and Linux: Ctrl, Alt by name', () => {
    assert.deepEqual(helpKeys(row('Project picker'), WIN), ['Ctrl', 'Alt', 'P']);
    assert.deepEqual(helpKeys(row('Config dir picker'), WIN), ['Ctrl', 'Alt', 'W']);
    assert.deepEqual(helpKeys(row('Jump to hub app by number'), WIN), ['Alt', '1…9']);
  });

  it('macOS: the hub keys are Control+Option', () => {
    assert.deepEqual(helpKeys(row('Project picker'), MAC), ['⌃', '⌥', 'P']);
    assert.deepEqual(helpKeys(row('Config dir picker'), MAC), ['⌃', '⌥', 'W']);
    assert.deepEqual(helpKeys(row('Previous / next hub app'), MAC), ['⌃', '⌥', '←/→']);
    assert.deepEqual(helpKeys(row('Jump to hub app by number'), MAC), ['⌃', '⌥', '1…9']);
  });

  it('every hub row is flagged', () => {
    const hub = SHORTCUT_PAIRS.flat().filter((g) => g.hub);
    assert.ok(hub.length > 0);
    for (const r of hub.flatMap((g) => g.rows)) assert.equal(r.hubMod, true, r.label);
  });

  it('the rows outside the Hub group are not flagged', () => {
    const others = SHORTCUT_PAIRS.flat().filter((g) => !g.hub).flatMap((g) => g.rows);
    for (const r of others) assert.equal(r.hubMod, undefined, r.label);
  });

  it('every hub row names its hub actions', () => {
    for (const r of SHORTCUT_PAIRS.flat().filter((g) => g.hub).flatMap((g) => g.rows)) {
      assert.ok([r.action].flat().every((a) => HUB_ACTIONS.includes(a)), r.label);
    }
  });

  it('a hub row shows the keys the hub reports, and hides when no key runs it', () => {
    hubLabels = {
      'hub.projectPicker': ['Ctrl', 'Alt', 'O'],
      'hub.prevApp,hub.nextApp': ['Ctrl', 'Alt', 'J/K'],
      'hub.configDirPicker': [],
    };
    try {
      assert.deepEqual(helpKeys(row('Project picker'), MAC), ['Ctrl', 'Alt', 'O']);
      assert.deepEqual(helpKeys(row('Previous / next hub app'), WIN), ['Ctrl', 'Alt', 'J/K']);
      assert.deepEqual(helpKeys(row('App launcher'), WIN), ['Ctrl', 'Alt', 'A'], 'not reported: the default');
      const html = page.buildHelpShortcuts();
      assert.match(html, /<kbd>O<\/kbd><\/dt><dd class="sc-l sc-hub">Project picker/);
      assert.doesNotMatch(html, /Config dir picker/);
      assert.match(html, /App launcher/);
    } finally {
      hubLabels = {};
    }
  });
});
