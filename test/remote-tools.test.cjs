const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../android/assets/remote-tools.js'), 'utf8');
const context = vm.createContext({}); vm.runInContext(source, context);
const map = (...args) => { const result = context.RemoteTools.framePoint(...args); return result && Array.from(result); };
test('remote direct taps account for letterbox and primary screen zero', () => {
  const frame = { screen: 0, rect: [0, 0, 1, 1] }, box = { left: 10, top: 20, width: 1000, height: 1000 };
  assert.equal(map(frame, box, 1920, 1080, 500, 30), null);
  assert.deepEqual(map(frame, box, 1920, 1080, 510, 520), ['p', 0, 5000, 5000]);
  assert.deepEqual(map(frame, box, 1920, 1080, 10, 238.75), ['p', 0, 0, 0]);
});
test('remote taps invert the displayed crop and reject absent frame geometry', () => {
  const frame = { screen: 2, rect: [0.25, 0.2, 0.5, 0.4] }, box = { left: 0, top: 0, width: 800, height: 400 };
  assert.deepEqual(map(frame, box, 1600, 800, 800, 400), ['p', 2, 7500, 6000]);
  assert.equal(map(frame, box, 0, 800, 0, 0), null);
  assert.equal(map(null, box, 1600, 800, 0, 0), null);
});
test('all Android inline scripts and extension scripts parse', () => {
  const html = fs.readFileSync(path.join(__dirname, '../android/assets/index.html'), 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  new vm.Script(source);
  for (const file of ['remote-tools.js', 'remote-tools.css', 'input.js']) assert.ok(fs.existsSync(path.join(__dirname, '../android/assets', file)));
  assert.match(html, /src="remote-tools\.js"/);
  assert.ok(html.indexOf('<script src="remote-tools.js"') < html.lastIndexOf('render();'));
  assert.doesNotMatch(html, /function openPad|function liveLoop|function snap\(|id="awayScreen"|id="openPad"|liveStop\(/);
  assert.match(html, /function renderScreen\(main\)\s*\{\s*RemoteTools\.mountScreen\(main\)/);
});

test('unified screen mounts in tab, follows cursor, and releases input on leaving', () => {
  const nodes = new Map(), requests = [], events = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', classList: { remove() {}, toggle() {} }, querySelectorAll: () => [], setPointerCapture() {} });
    return nodes.get(id);
  };
  const host = node('main');
  const ctx = vm.createContext({
    $: node, state: { allow: { input: true, screenshot: true }, screens: 3 },
    PAD_KEYS: [], esc: x => x, clearInterval() {},
    padStop: () => events.push('stop'), pad: { start: () => events.push('start'), ready: true },
    padSend: e => events.push(e), innerWidth: 400, innerHeight: 800, devicePixelRatio: 1,
    AdaptiveScreen: class { profile = { width: 960, quality: 60 }; },
    document: { hidden: false },
    getJson: url => { requests.push(url); return new Promise(() => {}); }
  });
  vm.runInContext(source, ctx);
  ctx.RemoteTools.mountScreen(host);
  assert.match(host.innerHTML, /remote-embedded/);
  assert.match(host.innerHTML, /За курсором/);
  assert.match(requests[0], /screen=-1&zoom=1\.000/);
  assert.doesNotMatch(requests[0], /[?&]c[xy]=/);
  node('#remoteStage').onpointerdown({ pointerId: 1, clientX: 10, clientY: 10 });
  node('#remoteStage').onpointermove({ pointerId: 1, clientX: 20, clientY: 15 });
  assert.deepEqual(Array.from(events.at(-1)), ['m', 16, 8]);
  node('#remoteZoom').onclick();
  ctx.RemoteTools.close();
  assert.equal(events.at(-1), 'stop');
  assert.equal(ctx.RemoteTools.active, false);
});
