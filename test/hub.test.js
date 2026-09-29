const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const HUB = 'http://localhost:3540';
const read = (file) => readFileSync(path.join(__dirname, '..', file), 'utf8');

// Runs the vendored SDK and the page's HUB_INTEGRATION region against stub browser globals.
async function loadHub() {
  const region = /\/\/ #region HUB_INTEGRATION\n([\s\S]*?)\/\/ #endregion/.exec(read('public/app.js'))[1];
  const listeners = { keydown: [], message: [], load: [] };
  const on = (type, fn) => listeners[type]?.push(fn);
  const posted = [];
  const calls = [];
  const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  const body = { classList: { contains: () => light }, dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  let light = false;
  const context = vm.createContext({
    parent,
    top: parent,
    URL,
    console,
    document: { readyState: 'complete', addEventListener: on, body },
    addEventListener: on,
    fetch: async () => ({ json: async () => ({ enabled: true, url: HUB }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    MutationObserver: class {
      observe() {}
    },
    hubActive: true,
    refreshIfStale: () => calls.push(['refresh', context.hubActive]),
    applyScope: (...args) => calls.push(['scope', ...args]),
    navigateToDetail: (id) => calls.push(['detail', id]),
    setColorTheme: (id) => {
      body.dataset.colorTheme = id;
      calls.push(['color', id]);
    },
    toggleTheme: () => {
      light = !light;
      calls.push(['toggle', light ? 'light' : 'dark']);
    },
  });
  context.window = context;
  vm.runInContext(read('public/vendor/claude-hub-sdk.js'), context);
  vm.runInContext(region, context);
  await new Promise((r) => setImmediate(r));

  return {
    calls,
    sent: () => posted.map((p) => p.message),
    press(init) {
      const before = posted.length;
      let prevented = false;
      const e = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: '', ...init };
      e.preventDefault = () => {
        prevented = true;
      };
      for (const fn of listeners.keydown) fn(e);
      const sent = posted.slice(before).filter((p) => p.message.type === 'hub:keydown');
      return sent.length === 1 && prevented;
    },
    receive(data, { source = parent, origin = HUB } = {}) {
      for (const fn of listeners.message) fn({ data, source, origin });
    },
  };
}

const KEYS = ['ctrl+alt+p', 'ctrl+alt+w', 'ctrl+alt+ArrowLeft', 'ctrl+alt+ArrowRight', 'alt+1', 'alt+2'];
const WELCOME = { type: 'hub:welcome', protocol: 1, forward: KEYS, themes: [], actions: ['session.cost'] };

describe('hub key forwarding', () => {
  it('forwards nothing until welcome', async () => {
    const hub = await loadHub();
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), false);
  });

  it('forwards only the listed combos after welcome', async () => {
    const hub = await loadHub();
    hub.receive(WELCOME);
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), true);
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'π', code: 'KeyP' }), true);
    assert.equal(hub.press({ altKey: true, key: '2', code: 'Digit2' }), true);
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), false);
    assert.equal(hub.press({ altKey: true, key: '3', code: 'Digit3' }), false);
  });

  it('ignores a welcome from another origin or frame', async () => {
    const hub = await loadHub();
    hub.receive(WELCOME, { origin: 'http://evil.example' });
    hub.receive(WELCOME, { source: {} });
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), false);
  });
});

describe('hub messages', () => {
  it('says hello with both topics and ignores hub:theme after welcome', async () => {
    const hub = await loadHub();
    const hello = hub.sent().find((m) => m.type === 'hub:hello');
    assert.deepEqual([...hello.subscribes].sort(), ['project.changed', 'theme.changed']);
    hub.receive(WELCOME);
    hub.receive({ type: 'hub:theme', theme: 'light', colorTheme: 'nord', vars: { '--accent': '#5e81ac' } });
    assert.deepEqual(hub.calls, []);
  });

  it('applies the v1 events and the session.cost action', async () => {
    const hub = await loadHub();
    hub.receive(WELCOME);
    hub.receive({ type: 'hub:event', topic: 'project.changed', payload: { encoded: 'C--p', name: 'p' } });
    hub.receive({ type: 'hub:event', topic: 'project.changed', payload: null });
    hub.receive({ type: 'hub:event', topic: 'theme.changed', payload: { theme: 'light', colorTheme: 'nord' } });
    hub.receive({ type: 'hub:action', id: '1', action: 'session.cost', params: { session: 's1' } });
    hub.receive({ type: 'hub:action', id: '2', action: 'session.cost', params: {} });
    hub.receive({ type: 'hub:active', active: false });
    hub.receive({ type: 'hub:active', active: true });
    assert.deepEqual(hub.calls, [
      ['scope', 'C--p', 'p'],
      ['scope', null, undefined],
      ['color', 'nord'],
      ['toggle', 'light'],
      ['detail', 's1'],
      ['refresh', true],
    ]);
  });

  it('ignores the v0 project and theme messages', async () => {
    const hub = await loadHub();
    hub.receive({ type: 'hub:project', project: 'C:/p', encoded: 'C--p', name: 'p' });
    hub.receive({ type: 'hub:theme', theme: 'light', colorTheme: 'nord' });
    assert.deepEqual(hub.calls, []);
  });
});
