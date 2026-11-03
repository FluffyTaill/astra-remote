import { isIP } from "node:net";

// Only home-network/loopback addresses; no public-IP opt-in or overlay-specific routes.
export function isLocalAddress(value) {
  let ip = String(value || "").split("%")[0].toLowerCase();
  if (ip.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    if (isIP(tail) === 4) ip = tail;
    else if (/^[a-f0-9]{1,4}:[a-f0-9]{1,4}$/.test(tail)) {
      const [a, b] = tail.split(":").map((s) => parseInt(s, 16));
      ip = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
  }
  if (isIP(ip) === 6) return ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
}

export function installLanPolicy(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    if (!isLocalAddress(socket.remoteAddress)) return socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.closeAccessSockets = () => { for (const socket of sockets) socket.destroy(); };
}
