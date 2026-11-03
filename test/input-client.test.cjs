const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../android/assets/input.js'), 'utf8');
function fixture() {
  let now = 1000, nextTimer = 0;
  const timers = new Map(), sent = [], stops = [], starts = [], states = [];
  const context = vm.createContext({
    Date: { now: () => now },
    setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(source, context);
  const bridge = { inputStart: (id) => starts.push(id), inputStop: (id) => stops.push(id),
    inputSend: (id, json) => { sent.push({ id, ...JSON.parse(json) }); return true; } };
  let resets = 0;
  const pad = new context.RemoteInput(bridge, { state: (text) => states.push(text), reset: () => resets++ });
  return { context, pad, sent, stops, starts, states, timers, resets: () => resets,
    advance: (ms) => { now += ms; }, ready: () => pad.receive(pad.id, '{"ready":true}') };
}
test('input pipelines eight batches without waiting for individual round trips', () => {
  const f = fixture(); f.pad.start(); f.ready();
  for (let n = 0; n < 8; n++) { f.pad.send(['m', 1, 2]); f.advance(25); f.pad.flush(); }
  assert.equal(f.sent.length, 8);
  f.pad.send(['m', 4, 5]); f.advance(25); f.pad.flush(); assert.equal(f.sent.length, 8);
  f.pad.receive(f.pad.id, '{"ack":8}'); f.pad.flush();
  assert.equal(f.sent.length, 9); assert.deepEqual(f.sent[8].events, [['m', 4, 5]]);
});
test('coalescing preserves press/move/release and text order', () => {
  const f = fixture(); f.pad.start(); f.ready();
  for (const event of [['m',1,2], ['m',3,4], ['b',0,1], ['m',2,3], ['b',0,2], ['t','a'], ['t','b'], ['k',13,0]]) f.pad.send(event);
  f.pad.flush();
  assert.deepEqual(f.sent[0].events, [['m',4,6], ['b',0,1], ['m',2,3], ['b',0,2], ['t','ab'], ['k',13,0]]);
});
test('stale motion is discarded and disconnected taps are never replayed', () => {
  const f = fixture(); f.pad.start(); f.pad.send(['b',0,0]); f.ready();
  f.pad.send(['m',8,9]); f.advance(300); f.pad.send(['k',13,0]); f.pad.flush();
  assert.deepEqual(f.sent[0].events, [['k',13,0]]);
  f.advance(2600); f.pad.flush(); assert.equal(f.pad.ready, false); assert.equal(f.pad.queue.length, 0);
  assert.equal(f.stops.length, 1);
  f.pad.send(['b',0,0]); assert.equal(f.pad.queue.length, 0);
});
test('generation ignores old acknowledgements and stop releases resources', () => {
  const f = fixture(); f.pad.start(); const old = f.pad.id; f.ready(); f.pad.stop(); f.pad.start();
  f.pad.receive(old, '{"ready":true}'); assert.equal(f.pad.ready, false);
  f.ready(); f.pad.send(['b',0,1]); f.pad.flush(); f.pad.stop();
  assert.equal(f.pad.pending.size, 0); assert.equal(f.pad.queue.length, 0); assert.equal(f.timers.size, 0);
  assert.ok(f.resets() >= 2);
});
test('slow or failed screenshots lower quality; sustained fast frames restore it gradually', () => {
  const f = fixture(); const a = new f.context.AdaptiveScreen(1280);
  assert.equal(a.profile.width, 640);
  a.sample(900, 80000); assert.equal(a.profile.width, 480);
  for (let n = 0; n < 11; n++) a.sample(90, 30000);
  assert.equal(a.profile.width, 480);
  a.sample(90, 30000); assert.equal(a.profile.width, 640);
  for (let n = 0; n < 24; n++) a.sample(90, 30000);
  assert.equal(a.profile.width, 1280);
  a.failure(); assert.equal(a.profile.width, 800);
  for (let n = 0; n < 10; n++) a.failure(); assert.equal(a.profile.width, 480);
  assert.ok(a.delay(1000) >= 35);
});
test('screen profiles never exceed display budget and oversized frames lower quality', () => {
  const f = fixture(); const a = new f.context.AdaptiveScreen(600);
  for (const profile of a.profiles) { assert.ok(profile.width <= 600); assert.ok(profile.quality >= 30); }
  a.sample(70, 300000); assert.equal(a.level, 0);
});
