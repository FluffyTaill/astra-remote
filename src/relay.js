// The way in from outside the home: a line to the relay (relay/worker.js, a Cloudflare Worker).
// Nothing is opened on this PC: the plugin itself connects out, and keeps the connection.
//
// For every phone that connects to the relay, the relay says {"open": sid, "ip": …} on the control
// line; the plugin opens that connection's own WebSocket and pipes it to its HTTPS server on
// 127.0.0.1. The phone then speaks the same pinned TLS as at home, so the relay only ever carries
// bytes it cannot read. The phone's real address is remembered by the local port, so the server's
// limits (wrong keys, pairing tries) still count per phone, not per relay.
import * as net from "node:net";
import WebSocket from "ws";

const PING_MS = 30000;
const BACKOFF = [2000, 5000, 15000, 30000, 60000];

// local port of a piped connection → the phone's address as the relay saw it
const viaRelay = new Map();
export const relayedIp = (localPort) => viaRelay.get(localPort) || "";

// deps: { url: "wss://…", id, key, port (the HTTPS server's), log(msg) }
export function startRelay(deps) {
  const base = String(deps.url).replace(/\/+$/, "");
  const headers = { "X-Relay-Key": deps.key };
  let ctl = null, pinger = null, retry = null, attempt = 0, stopped = false;
  const state = { status: "connecting", error: "" };

  function connect() {
    if (stopped) return;
    state.status = "connecting";
    ctl = new WebSocket(`${base}/pc/${deps.id}`, { headers, handshakeTimeout: 15000 });
    ctl.on("open", () => {
      attempt = 0;
      Object.assign(state, { status: "online", error: "" });
      deps.log?.("relay: online");
      pinger = setInterval(() => ctl.readyState === WebSocket.OPEN && ctl.send("ping"), PING_MS);
    });
    ctl.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text === "pong") return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.open && /^[a-z0-9]+$/.test(msg.open)) pipe(msg.open, String(msg.ip || ""));
    });
    ctl.on("unexpected-response", (_req, res) => {
      state.error = res.statusCode === 403 ? "ретранслятор не пускает этот ПК: он закрыт для чужих (ALLOWED_PCS) или номер занят другим ключом"
        : `ретранслятор ответил ${res.statusCode}`;
    });
    ctl.on("error", (e) => {
      if (!state.error) state.error = e.message;
    });
    ctl.on("close", () => {
      clearInterval(pinger);
      if (stopped) return;
      state.status = "offline";
      const wait = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
      retry = setTimeout(connect, wait);
    });
  }

  function pipe(sid, ip) {
    const ws = new WebSocket(`${base}/pc/${deps.id}/s/${sid}`, { headers, handshakeTimeout: 10000 });
    let local = null;
    const pending = [];
    ws.on("open", () => {
      local = net.connect({ host: "127.0.0.1", port: deps.port() });
      local.on("connect", () => {
        viaRelay.set(local.localPort, ip || "unknown");
        for (const b of pending) local.write(b);
        pending.length = 0;
      });
      local.on("data", (b) => ws.readyState === WebSocket.OPEN && ws.send(b));
      local.on("close", () => {
        if (local.localPort) viaRelay.delete(local.localPort);
        ws.close();
      });
      local.on("error", () => ws.close());
    });
    ws.on("message", (data) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (local && !local.connecting) local.write(b);
      else pending.push(b);
    });
    ws.on("close", () => local?.destroy());
    ws.on("error", () => local?.destroy());
  }

  connect();
  return {
    state: () => ({ ...state }),
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(pinger);
      try { ctl?.close(); } catch {}
    }
  };
}
