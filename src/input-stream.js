import { WebSocket, WebSocketServer } from "ws";
import { TextDecoder } from "node:util";

const PATH = "/api/input/stream";
const MAX_EVENTS = 400;
const MAX_PACKETS = 64;
const BATCH_SIZE = 200; // pc.input deliberately consumes at most 200 events.
const decoder = new TextDecoder("utf-8", { fatal: true });

// Authorization is deliberately synchronous: a message cannot create an unbounded
// queue of promises while credentials are being checked. LAN filtering belongs to
// the HTTP server's connection policy, not to this transport.
export function attachInputStream(server, { authenticate, input, enabled, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  const channels = new Set();
  const modifierOwners = new Map();
  const waiters = [];
  let stopped = false;
  let running = false;
  let scheduled = false;

  function authorize(req, deviceId) {
    const dev = authenticate(req);
    if (!dev || typeof dev.then === "function") throw statusError(401, "Unauthorized");
    if (deviceId !== undefined && dev.id !== deviceId) throw statusError(401, "Device changed");
    if (!enabled()) throw statusError(403, "Input is disabled");
    return dev;
  }

  function send(state, value) {
    if (state.ending || state.ws.readyState !== WebSocket.OPEN) return;
    if (state.ws.bufferedAmount > 64 * 1024) return fail(state, "Client is not reading replies");
    state.ws.send(Buffer.from(JSON.stringify(value) + "\n"), { binary: true }, (err) => {
      if (err) finish(state);
    });
  }

  function finish(state) {
    if (state.ending) return;
    state.ending = true;
    state.pending = [];
    schedule();
  }

  function fail(state, error, code = 1008) {
    if (state.ending) return;
    if (state.ws.readyState === WebSocket.OPEN && state.ws.bufferedAmount <= 64 * 1024) {
      state.ws.send(Buffer.from(JSON.stringify({ error: String(error?.message || error).slice(0, 500) }) + "\n"),
        { binary: true }, () => {});
    }
    finish(state);
    if (state.ws.readyState === WebSocket.OPEN) state.ws.close(code, "Input stream closed");
    // A peer that never completes the closing handshake must not keep a slot.
    state.closeTimer = setTimeout(() => state.ws.terminate(), 1000);
    state.closeTimer.unref?.();
  }

  function schedule() {
    if (scheduled || running) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void drain(); });
  }

  // There is one executor for ALL channels. A disconnect release cannot race a
  // still-running batch (or enqueue an unlimited number of pointer-worker jobs).
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (true) {
        const state = [...channels].find((s) => s.ending || s.pending.length);
        if (!state) break;
        if (state.ending) {
          const releases = [...state.held].map((button) => ["b", button, 2]);
          for (const key of state.modifiers) if (modifierOwners.get(key) === state) releases.push(["h", key, 0]);
          if (releases.length) {
            try { await input(releases); } catch { /* Best effort even after permission revocation. */ }
          }
          state.held.clear();
          for (const key of state.modifiers) if (modifierOwners.get(key) === state) modifierOwners.delete(key);
          state.modifiers.clear();
          channels.delete(state);
          continue;
        }
        const packets = state.pending;
        state.pending = [];
        const events = coalesce(packets.flatMap((packet) => packet.events));
        try {
          // Empty packets are allowed to warm the pointer worker.
          for (let offset = 0; offset < events.length || offset === 0; offset += BATCH_SIZE) {
            if (state.ending) break;
            state.dev = authorize(state.req, state.dev.id);
            const batch = events.slice(offset, offset + BATCH_SIZE);
            const before = new Set(state.held);
            const modifiersBefore = new Set(state.modifiers);
            for (const e of batch) {
              if (e[0] !== "h") continue;
              const owner = modifierOwners.get(e[1]);
              if (owner && owner !== state) throw new Error("Modifier is held by another controller");
              if (e[2] === 1) { modifierOwners.set(e[1], state); state.modifiers.add(e[1]); }
            }
            // If the worker partially executes and throws, release every button
            // this socket might have pressed; never release unrelated buttons.
            for (const e of batch) if (e[0] === "b" && e[2] !== 2) state.held.add(e[1]);
            await input(batch);
            state.held = before;
            state.modifiers = modifiersBefore;
            for (const e of batch) {
              if (e[0] === "h") {
                if (e[2] === 1) { state.modifiers.add(e[1]); modifierOwners.set(e[1], state); }
                else { state.modifiers.delete(e[1]); if (modifierOwners.get(e[1]) === state) modifierOwners.delete(e[1]); }
                continue;
              }
              if (e[0] !== "b") continue;
              if (e[2] === 1) state.held.add(e[1]);
              if (e[2] !== 1) state.held.delete(e[1]);
            }
          }
          if (!state.ending) {
            try { log(state.dev); } catch { /* Logging cannot change input delivery. */ }
            // A cumulative ACK covers every packet in this coalesced execution.
            send(state, { ack: packets.at(-1).seq });
          }
        } catch (err) {
          fail(state, err, err?.status ? 1008 : 1011);
        }
        state.eventCount -= packets.reduce((n, p) => n + p.events.length, 0);
        state.packetCount -= packets.length;
        // Fairness between devices, without making a per-packet worker queue.
        channels.delete(state);
        channels.add(state);
      }
    } finally {
      running = false;
      if (stopped && channels.size === 0) for (const resolve of waiters.splice(0)) resolve();
    }
  }

  function upgrade(req, socket, head) {
    if (stopped) return rejectUpgrade(socket, 503);
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch { return rejectUpgrade(socket, 400); }
    if (pathname !== PATH) return rejectUpgrade(socket, 404);
    if (req.method !== "GET") return rejectUpgrade(socket, 405);
    let dev;
    try { dev = authorize(req); }
    catch (err) { return rejectUpgrade(socket, err.status || 401); }
    if (channels.size >= 8 || [...channels].filter((s) => s.dev.id === dev.id).length >= 2) {
      return rejectUpgrade(socket, 429);
    }
    // handleUpgrade validates Connection/Upgrade, version and WebSocket key.
    wss.handleUpgrade(req, socket, head, (ws) => {
      const state = { ws, req, dev, pending: [], eventCount: 0, packetCount: 0,
        lastSeq: 0, lastPong: Date.now(), held: new Set(), modifiers: new Set(), ending: false, closeTimer: null };
      channels.add(state);
      ws.on("pong", () => { state.lastPong = Date.now(); });
      ws.on("close", () => { clearTimeout(state.closeTimer); finish(state); });
      ws.on("error", () => {
        finish(state);
        // ws has already sent the protocol close (e.g. 1009 for oversize).
        state.closeTimer = setTimeout(() => ws.terminate(), 1000);
        state.closeTimer.unref?.();
      });
      ws.on("message", (data, binary) => {
        if (state.ending) return;
        try {
          state.dev = authorize(req, state.dev.id);
          if (!binary) throw new Error("Expected binary JSON");
          const packet = JSON.parse(decoder.decode(data));
          if (!packet || !Number.isSafeInteger(packet.seq) || packet.seq <= state.lastSeq) {
            throw new Error("Sequence must be a positive, increasing safe integer");
          }
          const events = validateEvents(packet.events);
          if (state.packetCount >= MAX_PACKETS || state.eventCount + events.length > MAX_EVENTS) {
            throw new Error("Input queue is full");
          }
          state.lastSeq = packet.seq;
          state.pending.push({ seq: packet.seq, events });
          state.packetCount++;
          state.eventCount += events.length;
          schedule();
        } catch (err) { fail(state, err); }
      });
      send(state, { ready: true });
    });
  }

  const heartbeat = setInterval(() => {
    for (const state of channels) {
      if (state.ending) continue;
      try { state.dev = authorize(state.req, state.dev.id); }
      catch (err) { fail(state, err); continue; }
      if (Date.now() - state.lastPong >= 45000) {
        fail(state, "Heartbeat timed out");
        state.ws.terminate();
      } else if (state.ws.readyState === WebSocket.OPEN) state.ws.ping();
    }
  }, 15000);
  heartbeat.unref?.();
  server.on("upgrade", upgrade);
  server.once("close", stop);

  function stop() {
    if (!stopped) {
      stopped = true;
      clearInterval(heartbeat);
      server.removeListener("upgrade", upgrade);
      server.removeListener("close", stop);
      for (const state of channels) finish(state);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
    if (!channels.size && !running) return Promise.resolve();
    return new Promise((resolve) => { waiters.push(resolve); schedule(); });
  }
  return { stop };
}

function statusError(status, message) { return Object.assign(new Error(message), { status }); }

function rejectUpgrade(socket, status) {
  const phrases = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 429: "Too Many Requests", 503: "Service Unavailable" };
  const phrase = phrases[status] || "Unauthorized";
  const code = phrases[status] ? status : 401;
  socket.end(`HTTP/1.1 ${code} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroySoon?.();
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length > BATCH_SIZE) throw new Error("Invalid events batch");
  return events.map((e) => {
    if (!Array.isArray(e)) throw new Error("Invalid input event");
    const number = (i, min, max) => {
      if (typeof e[i] !== "number" || !Number.isFinite(e[i])) throw new Error("Invalid event number");
      return Math.max(min, Math.min(max, Math.round(e[i])));
    };
    switch (e[0]) {
      case "m":
      case "w": {
        if (e.length !== 3) break;
        const limit = e[0] === "m" ? 4000 : 2400;
        return [e[0], number(1, -limit, limit), number(2, -limit, limit)];
      }
      case "b":
        if (e.length !== 3 || !Number.isInteger(e[1]) || e[1] < 0 || e[1] > 2 ||
            !Number.isInteger(e[2]) || e[2] < 0 || e[2] > 2) break;
        return [...e];
      case "h":
        if (e.length === 3 && [16, 17, 18].includes(e[1]) && (e[2] === 0 || e[2] === 1)) return [...e];
        break;
      case "k": if (e.length === 3) return ["k", number(1, 1, 254), number(2, 0, 15)]; break;
      case "p": if (e.length === 4) return ["p", number(1, 0, 8), number(2, 0, 10000), number(3, 0, 10000)]; break;
      case "t": if (e.length === 2 && typeof e[1] === "string" && e[1].length <= 2000) return [...e]; break;
    }
    throw new Error("Invalid input event");
  });
}

function coalesce(events) {
  const result = [];
  for (const event of events) {
    const previous = result.at(-1);
    const limit = event[0] === "m" ? 4000 : event[0] === "w" ? 2400 : 0;
    // Do not clamp a SUM: it would silently lose movement/scroll. Leave an
    // additional event when merging would exceed pc.input's per-event bounds.
    if (limit && previous?.[0] === event[0] && Math.abs(previous[1] + event[1]) <= limit &&
        Math.abs(previous[2] + event[2]) <= limit) {
      previous[1] += event[1];
      previous[2] += event[2];
    } else result.push([...event]);
  }
  return result;
}
