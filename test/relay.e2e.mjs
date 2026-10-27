// End to end through a running relay (local: `npx wrangler dev` in relay/, or the deployed one):
//   node test/relay.e2e.mjs ws://127.0.0.1:8787
// A throwaway HTTPS server stands in for the plugin's; startRelay connects it to the relay; a "phone"
// opens /c/<id>, runs TLS over that WebSocket with the certificate pinned, and makes requests.
import * as https from "node:https";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket, { createWebSocketStream } from "ws";
import { startRelay, relayedIp } from "../src/relay.js";

const base = process.argv[2] || "ws://127.0.0.1:8787";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
  "-subj", "/CN=astra-remote", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem")], { stdio: "ignore" });
const key = fs.readFileSync(path.join(tmp, "k.pem")), cert = fs.readFileSync(path.join(tmp, "c.pem"));
const pin = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase();

let seen = "";
const server = https.createServer({ key, cert }, (req, res) => {
  seen = relayedIp(req.socket.remotePort);
  const body = req.url === "/big" ? crypto.randomBytes(3 * 1024 * 1024) : Buffer.from("hello " + req.url);
  res.writeHead(200, { "Content-Length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const id = crypto.randomBytes(16).toString("hex"), rkey = crypto.randomBytes(32).toString("hex");
const relay = startRelay({ url: base, id, key: rkey, port: () => port, log: console.log });
for (let i = 0; i < 50 && relay.state().status !== "online"; i++) await new Promise((r) => setTimeout(r, 200));
console.log("pc:", relay.state());

// another key cannot take this id
const thief = startRelay({ url: base, id, key: crypto.randomBytes(32).toString("hex"), port: () => port });
await new Promise((r) => setTimeout(r, 2500));
console.log("thief:", thief.state());
thief.stop();

async function phoneGet(p) {
  const ws = new WebSocket(`${base}/c/${id}`);
  await new Promise((ok, no) => { ws.once("open", ok); ws.once("error", no); ws.once("unexpected-response", (_q, r) => no(new Error("status " + r.statusCode))); });
  const sock = tls.connect({
    socket: createWebSocketStream(ws), rejectUnauthorized: false,
    checkServerIdentity: () => undefined
  });
  await new Promise((ok, no) => { sock.once("secureConnect", ok); sock.once("error", no); });
  const fp = new crypto.X509Certificate(sock.getPeerX509Certificate().raw).fingerprint256.replace(/:/g, "").toLowerCase();
  if (fp !== pin) throw new Error("pin mismatch");
  return new Promise((ok, no) => {
    const req = https.request({ createConnection: () => sock, path: p, method: "GET", host: "x" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", no);
    req.end();
  });
}

const t0 = Date.now();
const r1 = await phoneGet("/api/state");
console.log("small:", r1.status, r1.body.toString(), Date.now() - t0, "ms, seen ip:", JSON.stringify(seen));
const t1 = Date.now();
const r2 = await phoneGet("/big");
console.log("big:", r2.status, r2.body.length, "bytes in", Date.now() - t1, "ms");

relay.stop();
await new Promise((r) => setTimeout(r, 500));
try {
  await phoneGet("/x");
  console.log("offline: unexpectedly connected");
} catch (e) {
  console.log("offline:", e.message);
}
server.close();
process.exit(0);
