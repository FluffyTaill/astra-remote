// Astra Remote relay — a Cloudflare Worker that lets the phone reach the PC from anywhere, with no
// port opened on the PC and nothing to install on the phone.
//
// It only passes bytes. What goes through is the same HTTPS the app speaks at home: TLS from the phone
// to the PC's own server, with the certificate the phone pinned from the pairing QR code. The relay
// cannot read it, and cannot stand in for the PC.
//
//   GET /pc/<pcId>            the PC's control line (WebSocket, header X-Relay-Key). The first PC
//                             to claim an id owns it: the relay keeps a hash of its key.
//   GET /pc/<pcId>/s/<sid>    the PC's side of one phone connection (WebSocket, same key)
//   GET /c/<pcId>             a phone connection (WebSocket). 503 when the PC is not online.
//
// When a phone connects, the PC is told {"open": sid, "ip": "<phone address>"} on its control line
// and opens /pc/<pcId>/s/<sid>; from then on every message from one side goes to the other as is.
// One Durable Object per PC holds its sockets; hibernatable WebSockets let it sleep while idle.

const ID = /^[a-z0-9]{16,64}$/;
const OPEN_TIMEOUT_MS = 10000;
const MAX_PENDING = 64; // phone messages kept until the PC's side of the connection arrives
// A shared relay serves many PCs: one PC's room may not hog it. A phone keeps one or two connections
// open at a time, so these are far above what an app does and far below a flood.
const MAX_PHONE_SOCKETS = 24;   // open phone connections per PC
const MAX_OPENS_PER_MIN = 120;  // new phone connections per PC per minute

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/(pc|c)\/([a-z0-9]+)(?:\/s\/([a-z0-9]+))?$/);
    if (!m || !ID.test(m[2]) || (m[1] === "c" && m[3])) {
      return new Response(url.pathname === "/" ? "Astra Remote relay\n" : "not found\n", { status: url.pathname === "/" ? 200 : 404 });
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only\n", { status: 426 });
    // A private relay: with ALLOWED_PCS set (a secret: wrangler secret put ALLOWED_PCS, ids separated by
    // commas — the plugin page shows its PC's id), only those PCs may come in, and phones only to them.
    const allowed = String(env.ALLOWED_PCS || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(m[2])) return new Response("this relay is private\n", { status: 403 });
    // A Durable Object stays where it was first made. Pin it near the owner (Eastern Europe), so one
    // first connection through a far VPN does not leave every later one going round the world.
    return env.PC.get(env.PC.idFromName(m[2]), { locationHint: env.LOCATION || "eeur" }).fetch(req);
  }
};

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class PcRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map(); // sid → [messages from the phone before the PC's side arrived]
    this.opens = []; // when the last phone connections were opened (ms), for MAX_OPENS_PER_MIN
    // the PC's keep-alive is answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, kind, , sid] = url.pathname.match(/^\/(pc|c)\/([a-z0-9]+)(?:\/s\/([a-z0-9]+))?$/);

    if (kind === "pc") {
      const key = req.headers.get("X-Relay-Key") || "";
      if (key.length < 32) return new Response("key required\n", { status: 401 });
      const hash = await sha256(key);
      const owner = await this.ctx.storage.get("owner");
      if (owner && owner !== hash) return new Response("this id belongs to another PC\n", { status: 403 });
      if (!owner) await this.ctx.storage.put("owner", hash);

      const [client, server] = Object.values(new WebSocketPair());
      if (!sid) {
        // a new control line replaces the old one (the PC reconnected)
        for (const ws of this.ctx.getWebSockets("ctl")) ws.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["ctl"]);
      } else {
        const phone = this.ctx.getWebSockets("phone:" + sid)[0];
        if (!phone) return new Response("no such connection\n", { status: 404 });
        this.ctx.acceptWebSocket(server, ["pcdata:" + sid]);
        server.serializeAttachment({ side: "pc", sid });
        for (const msg of this.pending.get(sid) || []) server.send(msg);
        this.pending.delete(sid);
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // a phone
    const ctl = this.ctx.getWebSockets("ctl")[0];
    if (!ctl) return new Response("pc offline\n", { status: 503 });
    const now = Date.now();
    this.opens = this.opens.filter((t) => now - t < 60000);
    const phones = this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.side === "phone").length;
    if (phones >= MAX_PHONE_SOCKETS || this.opens.length >= MAX_OPENS_PER_MIN) return new Response("too many connections\n", { status: 429 });
    this.opens.push(now);
    const id = randomId();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["phone:" + id]);
    server.serializeAttachment({ side: "phone", sid: id });
    this.pending.set(id, []);
    ctl.send(JSON.stringify({ open: id, ip: req.headers.get("CF-Connecting-IP") || "" }));
    // the PC did not come for it: give up on this connection
    setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        try { server.close(4004, "pc did not answer"); } catch {}
      }
    }, OPEN_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  peerOf(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return null;
    return this.ctx.getWebSockets((a.side === "phone" ? "pcdata:" : "phone:") + a.sid)[0] || null;
  }

  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment();
    if (!a) return; // the control line: the PC says nothing on it but pings
    const peer = this.peerOf(ws);
    if (peer) return peer.send(msg);
    const q = a.side === "phone" ? this.pending.get(a.sid) : null;
    if (q && q.length < MAX_PENDING) q.push(msg);
    else ws.close(4005, "peer gone");
  }

  async webSocketClose(ws, code) {
    try { ws.close(1000, "closed"); } catch {}
    const a = ws.deserializeAttachment();
    if (!a) return;
    this.pending.delete(a.sid);
    const peer = this.peerOf(ws);
    if (peer) try { peer.close(1000, "peer closed"); } catch {}
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws, 1011);
  }
}
