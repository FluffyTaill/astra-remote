import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";

// bundle the server alone and drive it over HTTPS with a throwaway APPDATA
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-test-"));
const out = path.join(dir, "server.mjs");
execFileSync(process.execPath, [path.join("node_modules", "esbuild", "bin", "esbuild"), "test/harness.js", "--bundle", "--platform=node",
  "--format=esm", "--outfile=" + out,
  // ws (the relay) is CommonJS inside: an ESM bundle needs a real require for its built-ins
  "--banner:js=import{createRequire}from'module';const require=createRequire(import.meta.url);"], { stdio: "pipe" });

const shared = path.join(dir, "shared");

function start(env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [out], { env: { ...process.env, APPDATA: dir, AR_SHARED: shared, ...env } });
    p.stdout.on("data", (d) => {
      const m = String(d).match(/READY (\d+) (\S+) ([0-9a-f]{64})/);
      if (m) resolve({ p, port: Number(m[1]), secret: m[2], fp: m[3] });
    });
  });
}

// a tiny client that, like the app, trusts exactly one certificate; a Buffer body is sent as it is
function client(port, fp) {
  return (method, p, body, token) => new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body);
    const req = https.request({ host: "127.0.0.1", port, path: p, method, rejectUnauthorized: false,
      headers: { "Content-Type": raw ? "application/octet-stream" : "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } }, (res) => {
      const got = res.socket.getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase();
      if (got !== fp) return reject(new Error("certificate mismatch"));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, raw: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    if (body) req.write(raw ? body : JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pairAs(call, secret, name) {
  const r = await call("POST", "/api/pair", { secret, name });
  if (r.status !== 200) return r;
  for (let i = 0; i < 30; i++) {
    const w = await call("POST", "/api/pair/wait", { id: r.json.id, poll: r.json.poll });
    if (w.json.status !== "wait") return { ...w, check: r.json.check };
    await sleep(150);
  }
  throw new Error("pairing never answered");
}

test("pairing, auth and the API", async (t) => {
  const { p, port, secret, fp } = await start();
  t.after(() => p.kill());
  const call = client(port, fp);

  assert.equal((await call("GET", "/")).status, 404, "no web app any more");
  assert.equal((await call("GET", "/api/state")).status, 401);
  assert.equal((await call("POST", "/api/pair", { secret: "wrong", name: "x" })).status, 403);

  const denied = await pairAs(call, secret, "Intruder");
  assert.equal(denied.json.status, "denied", "the owner said no");

  const paired = await pairAs(call, secret, "Test");
  assert.equal(paired.json.status, "ok");
  assert.match(paired.check, /^\d{4}$/);
  const token = paired.json.token;
  assert.equal((await pairAs(call, secret, "Again")).status, 403, "the QR code is spent once a phone is allowed");

  const st = (await call("GET", "/api/state", null, token)).json;
  assert.equal(st.allow.shutdown, false);
  assert.deepEqual(st.buttons.map((b) => b.label), ["Test button"]);

  assert.equal((await call("POST", "/api/button", { n: 1 }, token)).status, 200);
  assert.equal((await call("POST", "/api/button", { n: 2 }, token)).status, 404);
  assert.equal((await call("POST", "/api/power", { action: "shutdown" }, token)).status, 403);

  const shot = await call("GET", "/api/screenshot?w=640", null, token);
  assert.equal(shot.status, 200);
  assert.equal(shot.raw[0], 0xff, "a JPEG");

  const chat = (await call("POST", "/api/chat", { text: "hi" }, token)).text;
  assert.match(chat, /"text":"echo: hi"/);

  assert.equal((await call("POST", "/api/unpair", {}, token)).status, 200);
  assert.equal((await call("GET", "/api/state", null, token)).status, 401, "revoked key is refused");
});

test("quiet chat sends heartbeats until Astra responds", async (t) => {
  const { p, port, secret, fp } = await start({ AR_CHAT_DELAY: "5000" });
  t.after(() => p.kill());
  const token = (await pairAs(client(port, fp), secret, "Slow chat")).json.token;
  const lines = [], gaps = [];
  let last = Date.now();
  await new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token } }, (res) => {
      assert.equal(res.socket.getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase(), fp);
      let buffered = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        gaps.push(Date.now() - last);
        last = Date.now();
        buffered += chunk;
        let i;
        while ((i = buffered.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffered.slice(0, i))); buffered = buffered.slice(i + 1); }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ text: "slow" }));
  });
  assert.ok(lines.filter((line) => line.waiting).length >= 3, "initial and periodic heartbeat");
  // released phones give up after 3 s of silence on home Wi-Fi
  assert.ok(Math.max(...gaps) < 2500, `longest silence ${Math.max(...gaps)} ms`);
  assert.ok(lines.some((line) => line.text === "echo: slow"));
  assert.equal(lines.at(-1).done, true);
});

test("shared folder: upload, list, download, nothing outside", async (t) => {
  const { p, port, secret, fp } = await start();
  t.after(() => p.kill());
  const call = client(port, fp);
  const token = (await pairAs(call, secret, "Files")).json.token;

  const up = await call("POST", "/api/files/upload?name=" + encodeURIComponent("фото 1.jpg"), Buffer.from("hello"), token);
  assert.equal(up.status, 200);
  assert.equal(up.json.saved, "С телефона/фото 1.jpg");
  const again = await call("POST", "/api/files/upload?name=" + encodeURIComponent("фото 1.jpg"), Buffer.from("x"), token);
  assert.equal(again.json.saved, "С телефона/фото 1 (2).jpg", "a second file with the same name does not overwrite");
  assert.equal((await call("POST", "/api/files/upload?name=..%2F..%2Fevil.txt", Buffer.from("x"), token)).json.saved, "С телефона/_.._evil.txt", "slashes and leading dots are cut");
  assert.equal((await call("POST", "/api/files/upload?name=big", Buffer.alloc(1.5 * 1048576), token)).status, 413, "over max_upload_mb");

  const top = (await call("GET", "/api/files?path=", null, token)).json;
  assert.deepEqual(top.items.filter((i) => i.dir).map((i) => i.name).sort(), ["Для телефона", "С телефона"]);
  const inbox = (await call("GET", "/api/files?path=" + encodeURIComponent("С телефона"), null, token)).json;
  assert.equal(inbox.items.length, 3, "no .part left behind");

  const down = await call("GET", "/api/files/download?path=" + encodeURIComponent("С телефона/фото 1.jpg"), null, token);
  assert.equal(down.status, 200);
  assert.equal(down.text, "hello");

  fs.writeFileSync(path.join(dir, "secret.txt"), "no");
  for (const bad of ["../secret.txt", "..\secret.txt", "С телефона/../../secret.txt", "C:/Windows/win.ini"]) {
    const r = await call("GET", "/api/files/download?path=" + encodeURIComponent(bad), null, token);
    assert.ok(r.status >= 400 && r.text !== "no", "refused: " + bad);
  }
  assert.equal((await call("GET", "/api/files/download?path=x", null, "wrong")).status, 401);
});

test("shutdown needs a yes at the PC", async (t) => {
  const { p, port, secret, fp } = await start({ AR_SHUTDOWN: "1" });
  t.after(() => p.kill());
  const call = client(port, fp);
  const token = (await pairAs(call, secret, "Power")).json.token;
  const r = await call("POST", "/api/power", { action: "shutdown" }, token);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /не подтвердили/);
});

test("a phone key runs out", async () => {
  const store = await import("../src/store.js");
  const old = { created: new Date(Date.now() - 91 * 86400000).toISOString() };
  assert.equal(store.expired(old, 90), true);
  assert.equal(store.expired(old, 0), false, "0 = for good");
  assert.equal(store.expired({ created: new Date().toISOString() }, 90), false);
});

test("Astra sends a file or a folder to the phone", async () => {
  const files = await import("../src/files.js");
  const cfg = { shared_folder: path.join(dir, "offer") };
  const src = path.join(dir, "отчёт.txt");
  fs.writeFileSync(src, "data");
  const one = files.offer(cfg, src);
  assert.deepEqual(one.map((x) => x.path), ["Для телефона/отчёт.txt"]);
  assert.deepEqual(files.offer(cfg, src).map((x) => x.path), ["Для телефона/отчёт (2).txt"], "never overwrites");
  const folder = path.join(dir, "album");
  fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
  fs.writeFileSync(path.join(folder, "a.jpg"), "a");
  fs.writeFileSync(path.join(folder, "sub", "b.jpg"), "b");
  assert.deepEqual(files.offer(cfg, folder).map((x) => x.path).sort(), ["Для телефона/album/a.jpg", "Для телефона/album/sub/b.jpg"]);
  const inside = path.join(cfg.shared_folder, "С телефона", "x.txt");
  fs.writeFileSync(inside, "x");
  assert.deepEqual(files.offer(cfg, inside).map((x) => x.path), ["С телефона/x.txt"], "already shared: not copied");
  assert.throws(() => files.offer(cfg, path.join(dir, "nope")), /Нет такого/);
});

test("state tells the app where the PC is now", async (t) => {
  const { p, port, secret, fp } = await start();
  t.after(() => p.kill());
  const call = client(port, fp);
  const token = (await pairAs(call, secret, "Away")).json.token;
  const st = (await call("GET", "/api/state", null, token)).json;
  assert.ok(Array.isArray(st.endpoints));
  for (const a of st.endpoints) assert.match(a, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(st.tuna, null);
  assert.equal(st.relay, undefined);
  assert.equal(st.connectionUrls, undefined);
});

test("paired state publishes only the enabled TUNA transport", async (t) => {
  const { p, port, secret, fp } = await start({ AR_TUNA: "1" });
  t.after(() => p.kill());
  const call = client(port, fp);
  assert.equal((await call("GET", "/api/state")).status, 401);
  const token = (await pairAs(call, secret, "Tunnel")).json.token;
  const st = (await call("GET", "/api/state", null, token)).json;
  assert.deepEqual(st.tuna, { v: 1, url: "https://test.ru.tuna.am", key: "a".repeat(64) });
  assert.equal(st.relay, undefined);
});

test("remote features keep permissions and confirm precise dangerous targets", async (t) => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "ar-allowed-api-"));
  fs.writeFileSync(path.join(allowed, "forgotten.txt"), "allowed test content");
  const { p, port, secret, fp } = await start({ AR_REMOTE_FEATURES: "1", AR_SHUTDOWN: "1", AR_ALLOWED: allowed });
  t.after(() => { p.kill(); fs.rmSync(allowed, { recursive: true, force: true }); });
  const call = client(port, fp), paired = await pairAs(call, secret, "Remote features");
  const token = paired.json.token;
  assert.equal((await call("GET", "/api/tasks")).status, 401);
  const state = (await call("GET", "/api/state", null, token)).json;
  assert.equal(state.allow.file_search, true); assert.equal(state.allow.tasks, true); assert.equal(state.allow.remote_shutdown, true);
  const roots = (await call("GET", "/api/library/roots", null, token)).json.roots;
  assert.equal(roots.length, 1); assert.equal(JSON.stringify(roots).includes(allowed), false);
  const query = "root=" + roots[0].id;
  assert.equal((await call("GET", "/api/library/list?" + query, null, token)).json.items[0].name, "forgotten.txt");
  assert.equal((await call("GET", "/api/library/search?" + query + "&q=forgot", null, token)).json.items[0].name, "forgotten.txt");
  assert.equal((await call("GET", "/api/library/download?" + query + "&path=forgotten.txt", null, token)).text, "allowed test content");
  assert.notEqual((await call("GET", "/api/library/download?" + query + "&path=..%2Foutside", null, token)).status, 200);
  const task = (await call("GET", "/api/tasks", null, token)).json.tasks[0];
  assert.equal(task.exe, undefined);
  assert.equal((await call("POST", "/api/tasks/action", { action: "kill", target: task }, token)).status, 403);
  const confirmation = (await call("POST", "/api/tasks/prepare", { target: task }, token)).json;
  assert.equal((await call("POST", "/api/tasks/action", { action: "kill", challenge: confirmation.challenge }, token)).status, 200);
  assert.equal((await call("POST", "/api/tasks/action", { action: "kill", challenge: confirmation.challenge }, token)).status, 403);
  const prepared = (await call("POST", "/api/power/prepare", { mode: "process", target: task }, token)).json;
  assert.ok(prepared.challenge);
  const armed = await call("POST", "/api/power/commit", { challenge: prepared.challenge }, token);
  assert.equal(armed.status, 200); assert.equal(armed.json.status, "waiting");
  assert.equal((await call("POST", "/api/power/cancel", {}, token)).json.status, "cancelled");
  const now = (await call("POST", "/api/power/prepare", { mode: "now" }, token)).json;
  assert.equal((await call("POST", "/api/power/commit", { challenge: now.challenge }, token)).json.status, "countdown");
  assert.equal((await call("POST", "/api/power/cancel", {}, token)).json.status, "cancelled");
});
