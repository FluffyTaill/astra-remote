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
});
