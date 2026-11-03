// TUNA terminates outer WSS only. The adapter never terminates the inner PC TLS session.
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";

export const TUNA_PORT = 18765;
export const TUNA_PATH = "/phone-remote/ws";
export const TUNA_HEADER = "x-phone-remote-tunnel";
const MAX_CONNECTIONS = 24, MAX_BUFFER = 512 * 1024, TOTAL_BUFFER = 8 * 1024 * 1024;
const tunnelPorts = new Map();
export const isTunaConnection = (port) => tunnelPorts.has(port);

export function tunaUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length > 300 || /[\s\\?#@]/.test(raw)) throw new Error("Нужна публичная HTTPS-ссылка TUNA без пути, логина и параметров");
  let u;
  try { u = new URL(raw); } catch { throw new Error("Укажи полную ссылку https://… из TUNA Desktop"); }
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.pathname !== "/" || u.hash || u.search
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:tuna\.am|tuna\.free)$/.test(u.hostname)) {
    throw new Error("Разрешена только HTTPS-ссылка поддомена tuna.am или tuna.free, без пути и отдельного порта");
  }
  return u.origin;
}

export function validTuna(record) {
  try { return !!record && record.v === 1 && !!tunaUrl(record.url) && /^[a-f0-9]{64}$/.test(record.key); }
  catch { return false; }
}

export function startTuna({ port = TUNA_PORT, backendPort, key, onActivity = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid transport key");
  const state = { status: "starting", error: "", port, lastConnection: "" };
  const entries = new Set(), sockets = new Set();
  let stopped = false, attempts = 0, since = Date.now();
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000 }, (_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end("Phone Remote: WebSocket transport only.\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on("connection", (socket) => {
    if (sockets.size >= 48) return socket.destroy();
    sockets.add(socket);
    socket.setTimeout(15000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  const reject = (socket, status = 403) => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };
  server.on("upgrade", (req, socket, head) => {
    if (Date.now() - since > 60000) { since = Date.now(); attempts = 0; }
    const supplied = req.headers[TUNA_HEADER];
    if (attempts >= 120 || entries.size >= MAX_CONNECTIONS) return reject(socket, 429);
    if (stopped || req.method !== "GET" || req.url !== TUNA_PATH || typeof supplied !== "string"
        || !/^[a-f0-9]{64}$/.test(supplied)
        || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
      attempts++;
      return reject(socket);
    }
    // Count failed authentication, not normal HTTP connection churn. Screenshots,
    // touchpad requests and reconnects can legitimately open >120 tunnels/minute.
    // Concurrent authenticated connections remain bounded by MAX_CONNECTIONS.
    socket.setTimeout(0);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (entries.size >= MAX_CONNECTIONS || stopped) return ws.terminate();
      const entry = { ws, tcp: null, stream: null, localPort: 0, alive: true };
      entries.add(entry);
      let closed = false;
      const cleanup = () => {
        if (closed) return; closed = true;
        if (entry.localPort) tunnelPorts.delete(entry.localPort);
        entries.delete(entry);
        entry.stream?.destroy(); entry.tcp?.destroy(); ws.terminate();
      };
      ws.on("error", cleanup); ws.on("close", cleanup);
      ws.on("pong", () => { entry.alive = true; });
      // createWebSocketStream supplies backpressure; reject text rather than treating it as TLS.
      ws.on("message", (_data, binary) => { if (!binary) cleanup(); });
      entry.stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
      entry.stream.on("error", cleanup);
      let destination;
      try { destination = Number(backendPort()); } catch { return cleanup(); }
      if (!Number.isInteger(destination) || destination < 1 || destination > 65535) return cleanup();
      entry.tcp = net.connect({ host: "127.0.0.1", port: destination });
      entry.tcp.setTimeout(10000, cleanup);
      entry.tcp.on("error", cleanup); entry.tcp.on("close", cleanup);
      entry.tcp.once("connect", () => {
        entry.tcp.setTimeout(0);
        entry.localPort = entry.tcp.localPort;
        tunnelPorts.set(entry.localPort, true);
        entry.stream.pipe(entry.tcp); entry.tcp.pipe(entry.stream);
        onActivity();
      });
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", (error) => {
    state.status = "error";
    state.error = error.code === "EADDRINUSE" ? `Порт TUNA ${port} занят. Останови тестовый сервер или выбери другой порт.` : error.message;
  });
  server.listen(port, "127.0.0.1", () => { state.status = "listening"; state.port = server.address().port; });
  const heartbeat = setInterval(() => {
    let total = 0;
    for (const entry of entries) {
      const size = entry.ws.bufferedAmount + (entry.tcp?.writableLength || 0) + (entry.stream?.writableLength || 0) + (entry.stream?.readableLength || 0);
      total += size;
      if (size > MAX_BUFFER || total > TOTAL_BUFFER) entry.ws.terminate();
    }
  }, 250);
  const ping = setInterval(() => {
    for (const entry of entries) { if (!entry.alive) { entry.ws.terminate(); continue; } entry.alive = false; entry.ws.ping(); }
  }, 30000);
  heartbeat.unref(); ping.unref();
  return {
    state: () => ({ ...state }),
    stop() {
      if (stopped) return; stopped = true;
      state.status = "off"; clearInterval(heartbeat); clearInterval(ping);
      for (const entry of entries) entry.ws.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close(); server.close();
    }
  };
}
