// Integration test through a user-authorized, already running TUNA Desktop tunnel.
// Uses throwaway keys and dummy data only, never the production plugin or its credentials.
// node test/tuna-live.cjs https://YOUR-DOMAIN.a.tuna.free
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const https = require('node:https'), tls = require('node:tls'), crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { buildSync } = require('esbuild');
const WebSocket = require('ws');
const { createWebSocketStream } = WebSocket;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuna-live-'));
const bundle = path.join(tmp, 'tuna.cjs');
buildSync({ entryPoints: [path.resolve('src/tuna.js')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { startTuna, tunaUrl, TUNA_PATH } = require(bundle);
const url = tunaUrl(process.argv[2]);
if (!url) throw Error('Supply the public HTTPS URL of your existing TUNA HTTP tunnel to 127.0.0.1:18765');
const key = crypto.randomBytes(32).toString('hex');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=test-only', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
const cert = fs.readFileSync(path.join(tmp, 'cert.pem'));
const pin = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
const dummy = crypto.randomBytes(3 * 1024 * 1024);
let count = 0, adapter;
const backend = https.createServer({ cert, key: fs.readFileSync(path.join(tmp, 'key.pem')) }, (req, res) => {
  count++;
  if (req.headers.authorization !== 'Bearer test-only-token') { res.writeHead(401); return res.end(); }
  res.writeHead(200, { 'Content-Length': dummy.length }); res.end(dummy);
});
function java(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('java', args); let output = '';
    const timeout = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}
(async () => {
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  adapter = startTuna({ port: 18765, backendPort: () => backend.address().port, key });
  for (let i = 0; i < 100 && adapter.state().status === 'starting'; i++) await new Promise(r => setTimeout(r, 20));
  if (adapter.state().status !== 'listening') throw Error(adapter.state().error || 'Adapter did not start');
  console.log('Temporary TUNA adapter ready; no production PC control is published.');
  const classes = path.join(tmp, 'classes'); fs.mkdirSync(classes);
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes,
    'android/src/tech/taill/astraremote/Endpoint.java', 'android/src/tech/taill/astraremote/TunaTunnel.java', 'android/src/tech/taill/astraremote/Pinned.java', 'test/java/tech/taill/astraremote/TunaPinnedProbe.java'], { stdio: 'pipe' });
  const failed = await java(['-cp', classes, 'tech.taill.astraremote.TunaPinnedProbe', url, key, '0'.repeat(64)]);
  if (failed.code === 0 || count !== 0 || !failed.output.includes('PIN_MISMATCH_BEFORE_AUTH')) throw Error('Wrong-pin test did not establish a verified certificate mismatch: ' + failed.output);
  console.log('PASS: real TUNA WSS + Android Java transport rejects wrong PC pin before API token.');
  const success = await java(['-cp', classes, 'tech.taill.astraremote.TunaPinnedProbe', url, key, pin]);
  if (success.code !== 0 || count !== 1) throw Error(success.output || 'Java transfer failed');
  console.log(success.output.trim());
  console.log('PASS: existing public TUNA tunnel supports actual app Java transport, nested TLS and authenticated dummy data.');
  console.log('Physical Android/mobile-network acceptance still requires installing the updated APK.');
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; }).finally(() => {
  adapter?.stop(); backend.closeAllConnections(); backend.close();
});
