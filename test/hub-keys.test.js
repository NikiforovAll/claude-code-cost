const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const HUB = 'http://localhost:3540';

// Runs the page's HUB_INTEGRATION region against stub browser globals.
async function loadShim() {
  const src = readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const region = /\/\/ #region HUB_INTEGRATION\n([\s\S]*?)\/\/ #endregion/.exec(src)[1];
  const listeners = { keydown: [], message: [] };
  const posted = [];
  const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  const window = { parent, addEventListener: (type, fn) => listeners[type]?.push(fn), toggleTheme() {} };
  const document = {
    addEventListener: (type, fn) => listeners[type]?.push(fn),
    body: { classList: { contains: () => false }, dataset: {} },
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    fetch: async () => ({ json: async () => ({ enabled: true, url: HUB }) }),
    MutationObserver: class {
      observe() {}
    },
  });
  vm.runInContext(region, context);
  await new Promise((r) => setImmediate(r));

  return {
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

describe('hub key forwarding', () => {
  it('forwards the old set until the hub sends its keys', async () => {
    const shim = await loadShim();
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), true);
    assert.equal(shim.press({ altKey: true, key: '7', code: 'Digit7' }), true);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' }), true);
    assert.equal(shim.press({ ctrlKey: true, key: 'q', code: 'KeyQ' }), false);
  });

  it('forwards only the listed combos after hub:keys', async () => {
    const shim = await loadShim();
    shim.receive({ type: 'hub:keys', keys: KEYS });
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), true);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'ArrowRight', code: 'ArrowRight' }), true);
    assert.equal(shim.press({ altKey: true, key: '2', code: 'Digit2' }), true);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), false);
    assert.equal(shim.press({ altKey: true, key: '3', code: 'Digit3' }), false);
    assert.equal(shim.press({ ctrlKey: true, altKey: true, shiftKey: true, key: 'P', code: 'KeyP' }), false);
  });

  it('names macOS composed characters by the physical key', async () => {
    const shim = await loadShim();
    shim.receive({ type: 'hub:keys', keys: KEYS });
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'π', code: 'KeyP' }), true);
    assert.equal(shim.press({ altKey: true, key: '¡', code: 'Digit1' }), true);
  });

  it('ignores hub:keys from another origin or frame', async () => {
    const shim = await loadShim();
    shim.receive({ type: 'hub:keys', keys: [] }, { origin: 'http://evil.example' });
    shim.receive({ type: 'hub:keys', keys: [] }, { source: {} });
    assert.equal(shim.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), true);
  });
});
