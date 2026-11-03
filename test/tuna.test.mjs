import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { Duplex, Writable } from "node:stream";
import { buildSync } from "esbuild";
import WebSocket, { WebSocketServer, createWebSocketStream } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tuna-tests-"));
const bundle = path.join(tmp, "transport.mjs");
buildSync({ stdin: { contents: 'export * from "./src/tuna.js"; export * from "./src/lan.js";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", outfile: bundle, banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" } });
const { startTuna, tunaUrl, validTuna, isLocalAddress, TUNA_PATH } = await import("file:///" + bundle.replace(/\\/g, "/"));
const secret = crypto.randomBytes(32).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(adapter) {
  for (let i = 0; i < 100; i++) {
    if (adapter.state().status === "listening") return adapter.state().port;
    if (adapter.state().status === "error") throw Error(adapter.state().error);
    await sleep(20);
  }
  throw Error("Adapter did not start");
}
function wsAt(port, key = secret, options = {}) {
  return new WebSocket(`ws://127.0.0.1:${port}${TUNA_PATH}`, { headers: { "X-Phone-Remote-Tunnel": key }, handshakeTimeout: 3000, perMessageDeflate: false, ...options });
}
async function rejected(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(Error("No rejection")); }, 4000);
    ws.on("error", () => {});
    ws.once("open", () => { clearTimeout(timer); ws.terminate(); reject(Error("Unexpected upgrade")); });
    ws.once("unexpected-response", (_req, res) => { clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode); });
  });
}

test("TUNA origin validation and LAN-only policy", () => {
  for (const s of ["https://unit.ru.tuna.am", "https://unit.a.tuna.free", "https://unit.tuna.free/"]) assert.ok(tunaUrl(s));
  assert.equal(tunaUrl("https://unit.tuna.am:443/"), "https://unit.tuna.am");
  for (const s of ["http://unit.tuna.am", "https://tuna.am", "https://tuna.free", "https://fake-tuna.am", "https://unit.tuna.am.attacker.ru", "https://unit.tuna.am:444", "https://user@unit.tuna.am", "https://unit.tuna.am/path", "https://unit.tuna.am?", "https://unit.tuna.am#", "https://127.0.0.1", "https://unit.tuna.am\\x"]) assert.throws(() => tunaUrl(s), undefined, s);
  assert.ok(validTuna({ v: 1, url: "https://unit.tuna.am", key: secret }));
  assert.ok(!validTuna({ v: 2, url: "https://unit.tuna.am", key: secret }));
  for (const ip of ["127.0.0.1", "192.168.1.2", "172.16.1.1", "10.0.0.1", "::ffff:192.168.1.1", "::ffff:c0a8:101", "::1", "fd00::1"]) assert.ok(isLocalAddress(ip), ip);
  for (const ip of ["8.8.8.8", "100.64.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "bad"]) assert.ok(!isLocalAddress(ip), ip);
});

test("adapter gate, text frames, oversize, disable, occupied port", async (t) => {
  const backend = net.createServer((socket) => socket.on("error", () => {}));
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const adapter = startTuna({ port: 0, backendPort: () => backend.address().port, key: secret });
  t.after(() => { adapter.stop(); backend.close(); });
  const port = await ready(adapter);
  assert.equal(await rejected(wsAt(port, "b".repeat(64))), 403);
  assert.equal(await rejected(new WebSocket(`ws://127.0.0.1:${port}/other`, { headers: { "X-Phone-Remote-Tunnel": secret } })), 403);
  for (const payload of ["text is not TLS", Buffer.alloc(300 * 1024)]) {
    const ws = wsAt(port); await once(ws, "open"); const closed = once(ws, "close"); ws.send(payload); await closed;
  }
  const ws = wsAt(port); await once(ws, "open");
  const other = startTuna({ port, backendPort: () => backend.address().port, key: secret });
  t.after(() => other.stop());
  for (let i = 0; i < 50 && other.state().status !== "error"; i++) await sleep(20);
  assert.match(other.state().error, /занят/);
  const closed = once(ws, "close"); adapter.stop(); await closed;
});

test("authenticated reconnect churn does not exhaust the failed-auth budget", async (t) => {
  const backend = net.createServer((socket) => socket.on("error", () => {}));
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const adapter = startTuna({ port: 0, backendPort: () => backend.address().port, key: secret });
  t.after(() => { adapter.stop(); backend.close(); });
  const port = await ready(adapter);
  for (let i = 0; i < 125; i++) {
    const ws = wsAt(port); await once(ws, "open");
    const closed = once(ws, "close"); ws.close(); await closed;
  }
  assert.equal(await rejected(wsAt(port, "b".repeat(64))), 403);
});

test("failed-auth attempts remain rate limited", async (t) => {
  const adapter = startTuna({ port: 0, backendPort: () => 1, key: secret });
  t.after(() => adapter.stop());
  const port = await ready(adapter);
  for (let i = 0; i < 120; i++) assert.equal(await rejected(wsAt(port, "b".repeat(64))), 403);
  assert.equal(await rejected(wsAt(port, "b".repeat(64))), 429);
});

// Throwaway certificates, never the user's PFX or key.
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=probe", "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem")], { stdio: "ignore" });
const cert = fs.readFileSync(path.join(tmp, "cert.pem")), key = fs.readFileSync(path.join(tmp, "key.pem"));
const pin = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase();

async function fixture(t) {
  const data = crypto.randomBytes(3 * 1024 * 1024); let requests = 0;
  const backend = https.createServer({ key, cert }, (req, res) => {
    requests++;
    if (req.headers.authorization !== "Bearer test-only-token") { res.writeHead(401); return res.end(); }
    if (req.url === "/upload") {
      const hash = crypto.createHash("sha256"); let bytes = 0;
      req.on("data", (b) => { bytes += b.length; hash.update(b); });
      req.on("end", () => res.end(JSON.stringify({ bytes, hash: hash.digest("hex") })));
    } else { res.writeHead(200, { "Content-Length": data.length }); res.end(data); }
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const adapter = startTuna({ port: 0, backendPort: () => backend.address().port, key: secret });
  const port = await ready(adapter);
  t.after(() => { adapter.stop(); backend.closeAllConnections(); backend.close(); });
  return { backend, adapter, port, data, requests: () => requests };
}
async function pinnedSocket(port, expectedPin) {
  const ws = wsAt(port); await once(ws, "open");
  const raw = createWebSocketStream(ws);
  // Match the Android transport's bounded 16-KiB binary frames even for large TLS writes.
  const upload = new Writable({ write(chunk, _encoding, done) {
    let offset = 0;
    const next = (error) => {
      if (error) return done(error);
      if (offset >= chunk.length) return done();
      const part = chunk.subarray(offset, offset + 16384); offset += part.length;
      raw.write(part, next);
    };
    next();
  }});
  const stream = Duplex.from({ readable: raw, writable: upload });
  stream.on("error", () => {});
  stream.once("close", () => { raw.destroy(); ws.terminate(); });
  const socket = tls.connect({ socket: stream, rejectUnauthorized: false });
  socket.on("error", () => {});
  await once(socket, "secureConnect");
  const got = new crypto.X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replace(/:/g, "").toLowerCase();
  if (got !== expectedPin) { socket.destroy(); ws.terminate(); throw Error("pin mismatch"); }
  return socket;
}
function call(socket, method = "GET", route = "/", body) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const req = https.request({ host: "probe", path: route, method, agent, headers: { Authorization: "Bearer test-only-token", ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
      const chunks = []; res.on("data", (b) => chunks.push(b)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("inner TLS over WebSocket: pin before credentials, download and streaming upload", async (t) => {
  const f = await fixture(t);
  await assert.rejects(pinnedSocket(f.port, "0".repeat(64)), /pin mismatch/);
  await sleep(50); assert.equal(f.requests(), 0, "no HTTP/token/body sent before pin");
  const result = await call(await pinnedSocket(f.port, pin));
  assert.equal(result.status, 200); assert.deepEqual(result.body, f.data);
  const uploaded = await call(await pinnedSocket(f.port, pin), "POST", "/upload", f.data);
  assert.deepEqual(JSON.parse(uploaded.body), { bytes: f.data.length, hash: crypto.createHash("sha256").update(f.data).digest("hex") });
  f.adapter.stop();
  // API itself remains available after the internet transport is disabled.
  const status = await new Promise((resolve, reject) => { https.get({ host: "127.0.0.1", port: f.backend.address().port, rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject); });
  assert.equal(status, 401);
});

const javaDir = path.join(tmp, "classes"); fs.mkdirSync(javaDir);
let javaAvailable = true;
try {
  execFileSync("javac", ["-encoding", "UTF-8", "-d", javaDir,
    "android/src/tech/taill/astraremote/Endpoint.java", "android/src/tech/taill/astraremote/TunaTunnel.java", "android/src/tech/taill/astraremote/Pinned.java", "android/src/tech/taill/astraremote/InputChannel.java",
    "test/java/tech/taill/astraremote/EndpointTest.java", "test/java/tech/taill/astraremote/TunaTransportTest.java", "test/java/tech/taill/astraremote/PinnedProbe.java", "test/java/tech/taill/astraremote/InputChannelProbe.java"], { stdio: "pipe" });
} catch (error) { if (error.code === "ENOENT") javaAvailable = false; else throw error; }

test("Java Android transport parser and LAN migration", { skip: !javaAvailable }, () => {
  execFileSync("java", ["-cp", javaDir, "tech.taill.astraremote.EndpointTest"], { stdio: "pipe" });
  execFileSync("java", ["-cp", javaDir, "tech.taill.astraremote.TunaTransportTest"], { stdio: "pipe" });
});

function runJava(port, expected, probe = "PinnedProbe", ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn("java", ["-cp", javaDir, "tech.taill.astraremote." + probe, String(port), expected, ...args]);
    let output = ""; p.stdout.on("data", (d) => output += d); p.stderr.on("data", (d) => output += d);
    p.on("error", reject); p.on("close", (code) => resolve({ code, output }));
  });
}
test("actual Java Pinned sends no token on mismatch through the WS byte path", { skip: !javaAvailable }, async (t) => {
  const f = await fixture(t); const connections = new Set();
  const proxy = net.createServer((socket) => {
    connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket));
    const ws = wsAt(f.port); ws.on("error", () => socket.destroy());
    ws.once("open", () => {
      const stream = createWebSocketStream(ws); stream.on("error", () => socket.destroy());
      socket.pipe(stream).pipe(socket); socket.once("close", () => stream.destroy());
    });
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => { for (const s of connections) s.destroy(); proxy.close(); });
  const failed = await runJava(proxy.address().port, "0".repeat(64));
  assert.notEqual(failed.code, 0); assert.equal(f.requests(), 0);
  const success = await runJava(proxy.address().port, pin);
  assert.equal(success.code, 0, success.output); assert.equal(f.requests(), 1);
});

test("Java input WebSocket pipelines inside pinned TLS over the TUNA byte path", { skip: !javaAvailable }, async (t) => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  f.backend.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/api/input/stream");
    assert.equal(req.headers.authorization, "Bearer test-only-token"); upgrades++;
    wss.handleUpgrade(req, socket, head, (ws) => {
      let count = 0;
      ws.send(Buffer.from('{"ready":true}\n'));
      ws.on("message", (bytes, binary) => {
        assert.ok(binary); const packet = JSON.parse(bytes);
        assert.equal(packet.seq, ++count);
        if (count === 4) ws.send(Buffer.from('{"ack":4}\n'));
      });
    });
  });
  const connections = new Set();
  const proxy = net.createServer((socket) => {
    connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket));
    const ws = wsAt(f.port); ws.on("error", () => socket.destroy());
    ws.once("open", () => {
      const stream = createWebSocketStream(ws); stream.on("error", () => socket.destroy());
      socket.pipe(stream).pipe(socket); socket.once("close", () => stream.destroy());
    });
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => { for (const socket of connections) socket.destroy(); proxy.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); });
  const failed = await runJava(proxy.address().port, "0".repeat(64), "InputChannelProbe");
  assert.notEqual(failed.code, 0); assert.equal(upgrades, 0, "no Authorization header before certificate pin passes");
  for (const mode of ["legacy", "origin"]) {
    const result = await runJava(proxy.address().port, pin, "InputChannelProbe", mode);
    assert.equal(result.code, 0, result.output);
  }
  assert.equal(upgrades, 2);
});
