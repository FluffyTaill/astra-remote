import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { WebSocket } from "ws";

// Source files are bundled by the plugin (the package intentionally is not ESM).
const temporary = mkdtempSync(path.join(os.tmpdir(), "ar-input-stream-"));
const bundle = path.join(temporary, "input-stream.mjs");
buildSync({ entryPoints: [fileURLToPath(new URL("../src/input-stream.js", import.meta.url))],
  outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" } });
const { attachInputStream } = await import(pathToFileURL(bundle).href);
after(() => rmSync(temporary, { recursive: true, force: true }));

const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function until(predicate, message = "condition did not become true") {
  const deadline = performance.now() + 2500;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay();
  }
}

async function fixture(t, execute = async () => {}) {
  const calls = [];
  const logs = [];
  const policy = { revoked: false, enabled: true, authCalls: 0 };
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const transport = attachInputStream(server, {
    authenticate(req) {
      policy.authCalls++;
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (!token?.startsWith("good") || policy.revoked) {
        throw Object.assign(new Error("Revoked or invalid token"), { status: 401 });
      }
      return { id: token, name: "Test phone" };
    },
    enabled: () => policy.enabled,
    async input(events) {
      calls.push(structuredClone(events));
      active++;
      maxActive = Math.max(maxActive, active);
      try { await execute(events, calls.length); } finally { active--; }
    },
    log: (dev) => logs.push(dev.id),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await transport.stop();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}`;
  async function connect(token = "good", options = {}) {
    const ws = new WebSocket(url + "/api/input/stream", {
      headers: { Authorization: "Bearer " + token }, ...options,
    });
    const messages = [];
    const errors = [];
    ws.on("message", (data, binary) => {
      assert.equal(binary, true, "server replies must be binary");
      assert.ok(data.toString().endsWith("\n"), "server replies are JSON lines");
      messages.push(...data.toString().trim().split("\n").map((line) => JSON.parse(line)));
    });
    ws.on("error", (error) => errors.push(error));
    const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
    await once(ws, "open");
    await until(() => messages.some((m) => m.ready), "missing ready frame");
    return { ws, messages, errors, closed,
      packet: (seq, events) => ws.send(Buffer.from(JSON.stringify({ seq, events }))),
      acks: () => messages.filter((m) => m.ack).map((m) => m.ack) };
  }
  async function rejectUpgrade(suffix, options = {}) {
    if (options.method) {
      return new Promise((resolve, reject) => {
        const req = http.request(url.replace("ws:", "http:") + suffix, { ...options,
          headers: { ...options.headers, Connection: "Upgrade", Upgrade: "websocket",
            "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("upgrade", (_res, socket) => { socket.destroy(); reject(new Error("Unexpected upgrade")); });
        req.on("error", reject);
        req.end();
      });
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url + suffix, options);
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        resolve(res.statusCode);
      });
      ws.on("error", () => {});
      ws.on("open", () => { ws.terminate(); reject(new Error("Unexpected upgrade")); });
    });
  }
  return { calls, logs, policy, connect, rejectUpgrade, transport, server, maxActive: () => maxActive };
}

test("binary ready and ACK arrive only after input execution", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, () => gate.promise);
  const c = await f.connect();
  assert.deepEqual(c.messages, [{ ready: true }]);
  c.packet(1, [["m", 2, -3]]);
  await until(() => f.calls.length === 1);
  assert.deepEqual(c.acks(), []);
  gate.resolve();
  await until(() => c.acks().length === 1);
  assert.deepEqual(c.acks(), [1]);
  assert.deepEqual(f.calls, [[["m", 2, -3]]]);
  assert.deepEqual(f.logs, ["good"]);
  assert.ok(f.policy.authCalls >= 3, "authorize upgrade, packet and execution");
});

test("pending motions coalesce across packets, preserving clicks and lossless PC limits", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
  const c = await f.connect();
  c.packet(1, [["m", 1, 0]]);
  await until(() => f.calls.length === 1);
  c.packet(2, [["m", 10, 20], ["m", 15, -5]]);
  c.packet(3, [["m", 2, 4], ["b", 0, 0], ["m", 4000, 0], ["m", 4000, 0],
    ["w", 1200, 0], ["w", 1200, 0], ["w", 1200, 0], ["k", 13, 0], ["t", "ok"]]);
  await until(() => f.policy.authCalls >= 5);
  assert.equal(f.calls.length, 1, "no per-message pointer worker jobs");
  gate.resolve();
  await until(() => c.acks().includes(3));
  assert.deepEqual(c.acks(), [1, 3], "one cumulative ACK for the coalesced group");
  assert.deepEqual(f.calls[1], [["m", 27, 19], ["b", 0, 0], ["m", 4000, 0], ["m", 4000, 0],
    ["w", 2400, 0], ["w", 1200, 0], ["k", 13, 0], ["t", "ok"]]);
  assert.equal(f.maxActive(), 1);
});

test("large pending snapshots are split into pc.input's 200-event limit before cumulative ACK", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
  const c = await f.connect();
  c.packet(1, []);
  await until(() => f.calls.length === 1);
  const keys = Array.from({ length: 150 }, () => ["k", 65, 0]);
  c.packet(2, keys);
  c.packet(3, keys);
  await until(() => f.policy.authCalls >= 5);
  gate.resolve();
  await until(() => c.acks().includes(3));
  assert.deepEqual(f.calls.map((events) => events.length), [0, 200, 100]);
  assert.deepEqual(c.acks(), [1, 3]);
});

for (const kind of ["events", "packets"]) {
  test(`backpressure closes on bounded outstanding ${kind}, dropping queued input`, async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve());
    const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
    const c = await f.connect();
    c.packet(1, [["b", 0, 1]]);
    await until(() => f.calls.length === 1);
    if (kind === "events") {
      const keys = Array.from({ length: 200 }, () => ["k", 65, 0]);
      c.packet(2, keys);
      c.packet(3, keys);
    } else {
      for (let seq = 2; seq <= 65; seq++) c.packet(seq, []);
    }
    assert.equal(await c.closed, 1008);
    assert.match(c.messages.find((m) => m.error).error, /queue is full/);
    assert.equal(f.calls.length, 1);
    gate.resolve();
    await until(() => f.calls.length === 2);
    assert.deepEqual(f.calls[1], [["b", 0, 2]]);
    assert.deepEqual(c.acks(), []);
  });
}

test("disconnect releases only this socket's held buttons after in-flight input", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
  const c = await f.connect();
  c.packet(1, [["b", 0, 1], ["b", 2, 1], ["b", 2, 2]]);
  await until(() => f.calls.length === 1);
  c.ws.terminate();
  await c.closed;
  await delay(20);
  assert.equal(f.calls.length, 1, "cleanup waits for input to settle");
  gate.resolve();
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls[1], [["b", 0, 2]]);
  assert.equal(f.maxActive(), 1);
});

test("successful click/unpressed socket disconnect does not issue unrelated releases", async (t) => {
  const f = await fixture(t);
  const holder = await f.connect("good-holder");
  const idle = await f.connect("good-idle");
  holder.packet(1, [["b", 1, 1], ["b", 1, 0]]);
  await until(() => holder.acks().length === 1);
  idle.ws.close();
  holder.ws.close();
  await Promise.all([idle.closed, holder.closed]);
  await f.transport.stop();
  assert.equal(f.calls.length, 1, "click has already released the previously pressed button");
});

test("partial worker failure conservatively releases all buttons it might have pressed", async (t) => {
  const f = await fixture(t, (_events, n) => { if (n === 1) throw new Error("Worker failed midway"); });
  const c = await f.connect();
  c.packet(1, [["b", 0, 1], ["b", 0, 2], ["b", 2, 0]]);
  assert.equal(await c.closed, 1011);
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls[1], [["b", 0, 2], ["b", 2, 2]]);
  assert.deepEqual(c.acks(), []);
  assert.match(c.messages.find((m) => m.error).error, /Worker failed/);
});

for (const permission of ["revoked", "enabled"]) {
  test(`rechecks ${permission} at execution, drops pending events but still releases`, async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve());
    const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
    const c = await f.connect();
    c.packet(1, [["b", 0, 1]]);
    await until(() => f.calls.length === 1);
    c.packet(2, [["m", 123, 0]]);
    await until(() => f.policy.authCalls >= 4);
    f.policy[permission] = permission === "revoked";
    gate.resolve();
    assert.equal(await c.closed, 1008);
    await until(() => f.calls.length === 2);
    assert.deepEqual(f.calls, [[["b", 0, 1]], [["b", 0, 2]]]);
    assert.ok(!c.acks().includes(2));
  });
}

test("rechecks revoked credentials on each packet even while input is blocked", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, () => gate.promise);
  const c = await f.connect();
  c.packet(1, [["m", 1, 0]]);
  await until(() => f.calls.length === 1);
  f.policy.revoked = true;
  c.packet(2, [["m", 2, 0]]);
  assert.equal(await c.closed, 1008);
  assert.match(c.messages.find((m) => m.error).error, /Revoked/);
  gate.resolve();
});

test("all channels share one executor, including safety releases", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
  t.after(() => gate.resolve());
  const a = await f.connect("good-a");
  const b = await f.connect("good-b");
  a.packet(1, [["b", 0, 1]]);
  await until(() => f.calls.length === 1);
  b.packet(1, [["k", 65, 0]]);
  a.ws.terminate();
  await a.closed;
  await delay(20);
  assert.equal(f.calls.length, 1);
  gate.resolve();
  await until(() => b.acks().includes(1));
  await f.transport.stop();
  assert.ok(f.calls.some((events) => events[0]?.[0] === "b" && events[0]?.[2] === 2));
  assert.equal(f.maxActive(), 1);
});

test("upgrade rejects wrong path, method, token and disabled permission promptly", async (t) => {
  const f = await fixture(t);
  const headers = { Authorization: "Bearer good" };
  assert.equal(await f.rejectUpgrade("/wrong", { headers }), 404);
  assert.equal(await f.rejectUpgrade("/api/input/stream/", { headers }), 404);
  assert.equal(await f.rejectUpgrade("/api/input/stream", { headers, method: "POST" }), 405);
  assert.equal(await f.rejectUpgrade("/api/input/stream"), 401);
  f.policy.enabled = false;
  assert.equal(await f.rejectUpgrade("/api/input/stream", { headers }), 403);
  assert.deepEqual(f.calls, []);
});

test("limits both per-device channels and total active channels", async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.connect();
  assert.equal(await f.rejectUpgrade("/api/input/stream", { headers: { Authorization: "Bearer good" } }), 429);
  for (let i = 1; i <= 6; i++) await f.connect("good" + i);
  assert.equal(await f.rejectUpgrade("/api/input/stream", { headers: { Authorization: "Bearer good-last" } }), 429);
});

const badPackets = [
  ["text frames", JSON.stringify({ seq: 1, events: [] })],
  ["invalid JSON", Buffer.from("not json")],
  ["invalid UTF-8", Buffer.from([0xff])],
  ["null packet", Buffer.from("null")],
  ["zero sequence", { seq: 0, events: [] }],
  ["fractional sequence", { seq: 1.5, events: [] }],
  ["unsafe sequence", { seq: Number.MAX_SAFE_INTEGER + 1, events: [] }],
  ["non-array events", { seq: 1, events: {} }],
  ["too many events", { seq: 1, events: Array.from({ length: 201 }, () => ["m", 1, 0]) }],
  ["unknown event", { seq: 1, events: [["shell", "bad"]] }],
  ["invalid button", { seq: 1, events: [["b", 3, 1]] }],
  ["invalid event number", { seq: 1, events: [["m", "1", 0]] }],
  ["oversize text event", { seq: 1, events: [["t", "x".repeat(2001)]] }],
];
for (const [name, value] of badPackets) {
  test(`malformed packet: ${name}`, async (t) => {
    const f = await fixture(t);
    const c = await f.connect();
    c.ws.send(typeof value === "string" || Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
    assert.equal(await c.closed, 1008);
    assert.equal(typeof c.messages.find((m) => m.error)?.error, "string");
    assert.deepEqual(f.calls, []);
  });
}

test("duplicate/non-monotonic sequence closes without executing replay", async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  c.packet(7, [["m", 1, 0]]);
  await until(() => c.acks().includes(7));
  c.packet(7, [["m", 2, 0]]);
  assert.equal(await c.closed, 1008);
  assert.equal(f.calls.length, 1);
});

test("32 KiB wire limit rejects oversized frames and releases held buttons", async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  c.packet(1, [["b", 0, 1]]);
  await until(() => c.acks().includes(1));
  c.ws.send(Buffer.alloc(32 * 1024 + 1, 32));
  assert.equal(await c.closed, 1009);
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls[1], [["b", 0, 2]]);
});

test("normalizes all supported event types to the existing PC bounds", async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  c.packet(1, [["m", 9999, -9999], ["w", -9999, 9999], ["k", 999, -1],
    ["p", 20, -20, 20000], ["t", "Привет"], ["b", 2, 0]]);
  await until(() => c.acks().includes(1));
  assert.deepEqual(f.calls[0], [["m", 4000, -4000], ["w", -2400, 2400], ["k", 254, 0],
    ["p", 8, 0, 10000], ["t", "Привет"], ["b", 2, 0]]);
});

test("heartbeat pings at 15s and disconnects after 45s without a pong", async (t) => {
  // Advance only Date/intervals; network I/O and polling timeouts remain real.
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const f = await fixture(t);
  const c = await f.connect("good", { autoPong: false });
  let pings = 0;
  c.ws.on("ping", () => pings++);
  c.packet(1, [["b", 1, 1]]);
  await until(() => c.acks().includes(1));
  t.mock.timers.tick(15000);
  await until(() => pings === 1);
  t.mock.timers.tick(30000);
  await c.closed;
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls[1], [["b", 1, 2]]);
  t.mock.timers.reset();
});

test("accepts sustained pipelined input without the HTTP API's 30/sec limiter", async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  for (let start = 1; start <= 80; start += 8) {
    for (let seq = start; seq < start + 8; seq++) c.packet(seq, [["m", 1, 0]]);
    await until(() => c.acks().includes(start + 7));
  }
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.deepEqual(c.messages.filter((m) => m.error), []);
  assert.equal(f.calls.flat().reduce((sum, e) => sum + e[1], 0), 80);
});

test("rechecks permission between chunks of a coalesced snapshot", async (t) => {
  const warm = deferred();
  const current = deferred();
  t.after(() => { warm.resolve(); current.resolve(); });
  const f = await fixture(t, (_events, n) => n === 1 ? warm.promise : n === 2 ? current.promise : undefined);
  const c = await f.connect();
  c.packet(1, []);
  await until(() => f.calls.length === 1);
  c.packet(2, [["b", 0, 1], ...Array.from({ length: 149 }, () => ["k", 65, 0])]);
  c.packet(3, Array.from({ length: 150 }, () => ["k", 66, 0]));
  await until(() => f.policy.authCalls >= 5);
  warm.resolve();
  await until(() => f.calls.length === 2);
  f.policy.revoked = true;
  current.resolve();
  assert.equal(await c.closed, 1008);
  await until(() => f.calls.length === 3);
  assert.deepEqual(f.calls[2], [["b", 0, 2]]);
  assert.ok(!c.acks().includes(2) && !c.acks().includes(3));
});

test("a live peer's pong keeps the heartbeat alive", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const f = await fixture(t);
  const c = await f.connect();
  let pings = 0;
  c.ws.on("ping", () => pings++);
  for (let i = 1; i <= 5; i++) {
    t.mock.timers.tick(15000);
    await until(() => pings === i);
    await delay(10); // Deliver the automatic pong back to the server.
  }
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  t.mock.timers.reset();
});

test("the HTTP server close hook detaches the upgrade listener", async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => f.server.close(resolve));
  assert.equal(f.server.listenerCount("upgrade"), 0);
  await f.transport.stop();
});

test("stop is idempotent, waits for in-flight input and releases, and detaches listener", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await fixture(t, (_events, n) => n === 1 ? gate.promise : undefined);
  const c = await f.connect();
  c.packet(1, [["b", 2, 1]]);
  await until(() => f.calls.length === 1);
  let stopped = false;
  const stop = f.transport.stop().then(() => { stopped = true; });
  await delay(20);
  assert.equal(stopped, false);
  assert.equal(f.server.listenerCount("upgrade"), 0);
  gate.resolve();
  await stop;
  await f.transport.stop();
  assert.deepEqual(f.calls[1], [["b", 2, 2]]);
  assert.equal(f.maxActive(), 1);
});

test("held modifiers release after disconnect and cannot be stolen by another channel", async (t) => {
  const f = await fixture(t);
  const first = await f.connect("good-one"), second = await f.connect("good-two");
  first.packet(1, [["h", 17, 1]]);
  await until(() => first.acks().includes(1));
  second.packet(1, [["h", 17, 0]]);
  await second.closed;
  assert.equal(f.calls.filter((batch) => batch.some((e) => e[0] === "h" && e[2] === 0)).length, 0);
  first.ws.terminate(); await first.closed;
  await until(() => f.calls.some((batch) => batch.some((e) => e[0] === "h" && e[1] === 17 && e[2] === 0)));
});

test("partial modifier worker error releases possible held keys", async (t) => {
  let failed = false;
  const f = await fixture(t, async (events) => {
    if (!failed && events.some((e) => e[0] === "h" && e[2] === 1)) { failed = true; throw Error("partial input"); }
  });
  const c = await f.connect(); c.packet(1, [["h", 16, 1], ["h", 18, 1]]);
  await c.closed;
  await until(() => f.calls.some((batch) => batch.some((e) => e[0] === "h" && e[1] === 18 && e[2] === 0)));
});
