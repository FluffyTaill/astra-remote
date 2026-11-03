const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('QR expansion survives polling and resets after pairing ends', () => {
  const source = fs.readFileSync('ui/app.js', 'utf8');
  const code = source.slice(source.indexOf('function paintPair()'), source.indexOf('\nfunction paintRequests()'));
  const classes = new Set();
  const box = { classList: {
    contains: x => classes.has(x), remove: x => classes.delete(x),
    toggle: x => classes.has(x) ? classes.delete(x) : classes.add(x)
  }};
  const button = { setAttribute(name, value) { this[name] = value; } }, left = {};
  const context = vm.createContext({ qr: '<svg></svg>', state: { pairing: { until: Date.now() + 60000 } },
    $: id => ({ '#pairBox': box, '#qrSize': button, '#left': left })[id],
    setHtml: (el, html) => { const changed = el.html !== html; el.html = html; return changed; }
  });
  vm.runInContext(code + '\npaintPair();', context);
  assert.equal(button['aria-expanded'], 'false');
  button.onclick();
  assert.equal(button['aria-expanded'], 'true');
  assert.equal(button.textContent, 'Уменьшить QR-код');
  vm.runInContext('paintPair()', context);
  assert.equal(button['aria-expanded'], 'true', 'polling must not collapse the QR');
  context.state.pairing = null;
  vm.runInContext('paintPair()', context);
  assert.equal(classes.has('qr-expanded'), false);
  assert.equal(box.html, '');
});

test('QR layout has larger normal and expanded sizes with responsive square geometry', () => {
  const html = fs.readFileSync('ui/index.html', 'utf8');
  assert.match(html, /grid-template-columns:minmax\(0,460px\)/);
  assert.match(html, /\.qr\{[^}]*aspect-ratio:1/);
  assert.match(html, /\.qr-expanded \.qr\{width:min\(100%,680px\)/);
  assert.match(html, /@media \(max-width:800px\)/);
  assert.doesNotMatch(html, /\.qr\{[^}]*height:300px/);
});
