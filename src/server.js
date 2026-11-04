// The phone API accepts home-network/loopback connections only; internet traffic arrives inside TUNA.
// TLS is pinned by the phone and every API call still requires pairing/authentication.
import * as https from "node:https";
import * as tls from "node:tls";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as pc from "./pc.js";
import * as store from "./store.js";
import * as files from "./files.js";
import { isTunaConnection } from "./tuna.js";
import { attachInputStream } from "./input-stream.js";
import { isLocalAddress, installLanPolicy } from "./lan.js";
import * as avatar from "./avatar.js";
import * as apps from "./apps.js";
import { makeTaskManager } from "./tasks.js";
import { createPowerManager } from "./power.js";

const MAX_BODY = 128 * 1024; // JSON only; files stream past this

// ── who may connect at all ──────────────────────────────────────────────────

// Home adapter addresses; virtual adapters only waste phone connection timeouts.
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback/i;
export function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal || !isLocalAddress(a.address)) continue;
      out.push({ address: a.address, name });
    }
  }
  return out;
}

// ── limits ──────────────────────────────────────────────────────────────────
// Wrong keys or pairing secrets: 10 per 10 minutes per address, then the address is shut out for 10 minutes.
const failures = new Map();
function blocked(ip) {
  const f = failures.get(ip);
  return f && f.blockedUntil > Date.now();
}
function fail(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.since > 600000) f = { n: 0, since: now, blockedUntil: 0 };
  if (++f.n >= 10) f.blockedUntil = now + 600000;
  failures.set(ip, f);
}

// Requests per device: a bucket of 60 refilling 30 a second — a volume slider fits, a flood does not.
const buckets = new Map();
function allow(deviceId) {
  const now = Date.now();
  const b = buckets.get(deviceId) || { tokens: 60, at: now };
  b.tokens = Math.min(60, b.tokens + ((now - b.at) / 1000) * 30);
  b.at = now;
  buckets.set(deviceId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ── helpers ─────────────────────────────────────────────────────────────────

// No proxy headers are trusted. All tunneled pre-auth attempts share a stable source bucket.
const ipOf = (req) => isTunaConnection(req.socket.remotePort) ? "TUNA" : String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, code, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(httpError(400, "bad json"));
      }
    });
    req.on("error", reject);
  });
}

// SHA-256 of this PC's certificate: what the QR code tells the app to trust, and nothing else.
export function certFingerprint() {
  const der = tls.createSecureContext({ pfx: fs.readFileSync(store.PFX), passphrase: store.tlsPass() }).context.getCertificate();
  return new crypto.X509Certificate(der).fingerprint256.replace(/:/g, "").toLowerCase();
}

// ── the server ──────────────────────────────────────────────────────────────
// deps: { config(), fireButton(n), chat(text, fresh), onChange(), confirm?(text) → Promise<boolean> }
export function createServer(deps) {
  const confirm = deps.confirm || pc.confirmOnPc;
  const need = (flag, message) => {
    if (!deps.config()[flag]) throw httpError(403, message);
  };
  const inputLogged = new Map(); // device → when its touchpad use was last written to the log
  const liveLogged = new Map(); // the same for the live view
  const searches = new Map(), killChallenges = new Map();
  const tasks = makeTaskManager({
    list: deps.runningTasks || pc.runningTasks,
    action: deps.taskAction || pc.taskAction,
    state: deps.processState || pc.processState
  });
  const power = createPowerManager({
    config: deps.config,
    deviceValid(id) { const dev = store.devices().find((d) => d.id === id); return !!dev && !store.expired(dev, deps.config().key_days); },
    processState: deps.processState || pc.processState,
    shutdown: deps.shutdown || pc.powerNowShutdown,
    log: (dev, text, ok = true) => store.logAction(dev, text, ok)
  });
  const taskTarget = async (target) => {
    if (!target || !Number.isInteger(target.pid) || typeof target.created !== "string" || typeof target.window !== "string") throw httpError(400, "Недопустимая программа");
    const found = (await tasks.list()).find((t) => t.pid === target.pid && t.created === target.created && t.window === target.window);
    if (!found) throw httpError(409, "Программа уже закрыта или изменилась. Обнови список.");
    return found;
  };
  const routes = {
    "GET /api/state": async (_b, dev) => {
      const cfg = deps.config();
      const [vol, media, screens] = await Promise.all([
        pc.volume().catch(() => null), pc.nowPlaying(), cfg.allow_screenshot ? pc.screens().catch(() => 1) : 0
      ]);
      return {
        device: { name: dev.name, expires: store.expiresAt(dev, cfg.key_days) }, system: { ...pc.system(), ...pc.moreStats() }, volume: vol, media, screens,
        notes: store.notes().slice(0, 1).map((n) => n.id)[0] || 0, // the newest note: the app fetches what it has not seen
        buttons: store.buttons().filter((b) => b.label),
        sent: cfg.allow_files ? store.sent() : [],
        endpoints: addresses().map((a) => a.address),
        tuna: deps.tuna?.() || null,
        allow: {
          screenshot: !!cfg.allow_screenshot, power: !!cfg.allow_power, shutdown: !!cfg.allow_shutdown, chat: !!cfg.allow_chat,
          files: !!cfg.allow_files, clipboard: !!cfg.allow_clipboard, open_url: !!cfg.allow_open_url, confirm: !!cfg.confirm_shutdown,
          input: !!cfg.allow_input, launch: !!cfg.allow_launch, voice: !!cfg.voice_to_phone,
          file_search: !!cfg.allow_file_search, tasks: !!cfg.allow_tasks,
          remote_shutdown: !!cfg.allow_power && !!cfg.allow_shutdown && !!cfg.allow_remote_shutdown
        },
        powerJob: power.state()
      };
    },
    "POST /api/media": async (body, dev) => {
      await pc.mediaKey(String(body.key));
      store.logAction(dev, "медиа: " + body.key);
      return { ok: true };
    },
    "POST /api/volume": async (body) => pc.setVolume(body),
    // the cover of what plays (the app asks again when the track changes) and moving through it
    "GET /api/media/cover": async () => ({ cover: await pc.cover().catch(() => null) }),
    "POST /api/media/seek": async (body) => {
      await pc.seek(body.sec);
      return { ok: true };
    },
    // each app's own volume
    "GET /api/volume/apps": async () => ({ apps: await pc.appVolumes() }),
    "POST /api/volume/app": async (body) => ({ apps: await pc.setAppVolume(body) }),
    // the touchpad and the keyboard: a batch of events, logged once per session of use
    "POST /api/input": async (body, dev) => {
      need("allow_input", "Тачпад и клавиатура выключены в настройках плагина");
      if (Array.isArray(body.events) && body.events.some((e) => e?.[0] === "h")) throw httpError(400, "Удерживаемые клавиши требуют постоянного канала");
      await pc.input(body.events);
      if (Date.now() - (inputLogged.get(dev.id) || 0) > 600000) store.logAction(dev, "тачпад и клавиатура");
      inputLogged.set(dev.id, Date.now());
      return { ok: true };
    },
    // the touchpad's live view: the screen with the pointer ringed, as fast as the phone asks
    "GET /api/screen/live": async (_b, dev, url) => {
      need("allow_screenshot", "Снимок экрана выключен в настройках плагина");
      const q = (k, d) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : d);
      const frame = await pc.liveFrame({ screen: q("screen", -1), width: q("w", 960), zoom: q("zoom", 1), quality: q("q", 60),
        centerX: url.searchParams.has("cx") ? q("cx", 0.5) : null, centerY: url.searchParams.has("cy") ? q("cy", 0.5) : null });
      if (Date.now() - (liveLogged.get(dev.id) || 0) > 600000) store.logAction(dev, "смотрит экран в тачпаде");
      liveLogged.set(dev.id, Date.now());
      return frame;
    },
    // the launcher: the phone sees names and ids, never paths
    "GET /api/apps": async () => {
      need("allow_launch", "Запуск программ выключен в настройках плагина");
      return { apps: await apps.list() };
    },
    "POST /api/apps/launch": async (body, dev) => {
      need("allow_launch", "Запуск программ выключен в настройках плагина");
      const name = await apps.launch(body.id);
      store.logAction(dev, "запустил " + name);
      return { ok: true };
    },
    "POST /api/button": async (body, dev) => {
      const b = store.buttons().find((x) => x.n === Number(body.n));
      if (!b || !b.label) throw httpError(404, "Нет такой кнопки");
      await deps.fireButton(b.n);
      store.logAction(dev, `кнопка ${b.n} «${b.label}»`);
      return { ok: true };
    },
    "POST /api/power": async (body, dev) => {
      const cfg = deps.config();
      const action = String(body.action);
      if (!cfg.allow_power && action !== "cancel") throw httpError(403, "Питание выключено в настройках плагина");
      if (action === "shutdown" || action === "restart") {
        if (!cfg.allow_shutdown) throw httpError(403, "Выключение и перезагрузка запрещены в настройках плагина");
        if (cfg.confirm_shutdown) {
          const verb = action === "shutdown" ? "выключить" : "перезагрузить";
          const ok = await confirm(`Телефон «${dev.name}» просит ${verb} этот компьютер через минуту.

Разрешить?`);
          if (!ok) {
            store.logAction(dev, "питание: " + action + " — на ПК не подтвердили", false);
            throw httpError(403, "На ПК не подтвердили");
          }
        }
      }
      await pc.power(action);
      store.logAction(dev, "питание: " + action);
      return { ok: true };
    },
    "GET /api/clipboard": async (_b, dev) => {
      need("allow_clipboard", "Буфер обмена выключен в настройках плагина");
      store.logAction(dev, "буфер ПК → телефон");
      return { text: await pc.clipboard() };
    },
    "POST /api/clipboard": async (body, dev) => {
      need("allow_clipboard", "Буфер обмена выключен в настройках плагина");
      const text = String(body.text ?? "");
      if (!text) throw httpError(400, "empty");
      await pc.setClipboard(text);
      store.logAction(dev, "буфер телефона → ПК");
      return { ok: true };
    },
    "POST /api/open": async (body, dev) => {
      need("allow_open_url", "Открытие ссылок выключено в настройках плагина");
      await pc.openUrl(body.url);
      store.logAction(dev, "открыл ссылку " + new URL(String(body.url)).host);
      return { ok: true };
    },
    // the shared folder (or a folder inside it) opened on the PC's screen, in Explorer
    "POST /api/files/open": async (body, dev) => {
      need("allow_files", "Обмен файлами выключен в настройках плагина");
      const dir = files.resolveDir(deps.config(), String(body.path || ""));
      pc.openFolder(dir);
      store.logAction(dev, "открыл общую папку на ПК");
      return { ok: true };
    },
    "GET /api/files": async (_b, _dev, url) => {
      need("allow_files", "Обмен файлами выключен в настройках плагина");
      return files.list(deps.config(), url.searchParams.get("path"));
    },
    // the avatar: the worn character's model and its pack's VRMA motions (the files come below, streamed)
    "GET /api/avatar": async () => avatar.info() || { none: true },
    // notes Astra left for the phone, newer than the one it has
    "GET /api/notes": async (_b, _dev, url) => {
      const since = Number(url.searchParams.get("since")) || 0;
      return { notes: store.notes().filter((n) => n.id > since).slice(0, 20) };
    },
    "GET /api/library/roots": async () => { need("allow_file_search", "Поиск файлов не разрешён на ПК"); return { roots: files.allowedRoots(deps.config()) }; },
    "GET /api/library/list": async (_b, _dev, url) => {
      need("allow_file_search", "Поиск файлов не разрешён на ПК");
      return files.listAllowed(deps.config(), url.searchParams.get("root"), url.searchParams.get("path") || "");
    },
    "GET /api/tasks": async () => { need("allow_tasks", "Управление программами не разрешено на ПК"); return { tasks: await tasks.list() }; },
    "POST /api/tasks/prepare": async (body, dev) => {
      need("allow_tasks", "Управление программами не разрешено на ПК");
      const target = await taskTarget(body.target);
      const now = Date.now();
      for (const [key, value] of killChallenges) if (value.expiresAt <= now) killChallenges.delete(key);
      if (killChallenges.size >= 16) throw httpError(429, "Слишком много подтверждений");
      const challenge = crypto.randomBytes(24).toString("hex"), expiresAt = now + 60000;
      killChallenges.set(challenge, { owner: dev.id, target, expiresAt });
      return { challenge, expiresAt, name: target.name, title: target.title };
    },
    "POST /api/tasks/action": async (body, dev) => {
      need("allow_tasks", "Управление программами не разрешено на ПК");
      const action = String(body.action);
      if (!["activate", "close", "kill"].includes(action)) throw httpError(400, "Недопустимое действие");
      let target;
      if (action === "kill") {
        const key = String(body.challenge || ""), confirmation = killChallenges.get(key);
        if (!confirmation || confirmation.owner !== dev.id || confirmation.expiresAt <= Date.now()) throw httpError(403, "Подтверди завершение программы заново");
        killChallenges.delete(key);
        target = await taskTarget(confirmation.target);
      } else target = await taskTarget(body.target);
      const result = await tasks.action(target, action);
      store.logAction(dev, "программа: " + action + " — " + target.name);
      return result || { ok: true };
    },
    "GET /api/power/job": async () => { power.reconcile(); return power.state(); },
    "POST /api/power/prepare": async (body, dev) => {
      let target;
      if (body.mode === "process") { need("allow_tasks", "Сначала разреши управление программами"); target = await taskTarget(body.target); }
      return power.prepare(dev, { mode: body.mode, target });
    },
    "POST /api/power/commit": async (body, dev) => power.commit(dev, { challenge: body.challenge }),
    "POST /api/power/cancel": async (_body, dev) => power.cancel(dev),
    "POST /api/unpair": async (_b, dev) => {
      store.logAction(dev, "отключился сам");
      store.revoke(dev.id);
      deps.onChange();
      return { ok: true };
    },
  };

  const options = { pfx: fs.readFileSync(store.PFX), passphrase: store.tlsPass(), minVersion: "TLSv1.2", handshakeTimeout: 10000 };
  const server = https.createServer(options, async (req, res) => {
    const ip = ipOf(req);
    const url = new URL(req.url, "https://x");
    const key = `${req.method} ${url.pathname}`;
    try {
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (blocked(ip)) return send(res, 429, { error: "Слишком много неудачных попыток. Подожди 10 минут." });

      // pairing: only with the secret from the QR code, and only once the owner allows it on the PC
      if (key === "POST /api/pair") {
        const body = await readJson(req);
        const r = store.requestPairing(String(body.secret || ""), body.name, ip);
        if (r.error === "bad_secret") {
          fail(ip);
          return send(res, 403, { error: "QR-код устарел. Открой Phone Remote в Astra на ПК и нажми «Подключить телефон» ещё раз" });
        }
        if (r.error) return send(res, 429, { error: "Слишком много запросов на подключение" });
        deps.onChange();
        return send(res, 200, r);
      }
      if (key === "POST /api/pair/wait") {
        const body = await readJson(req);
        const r = store.pollPairing(String(body.id || ""), String(body.poll || ""));
        if (r.status === "ok") {
          store.logAction(store.deviceByToken(r.token, ip), "подключён");
          deps.onChange();
        }
        return send(res, 200, r);
      }

      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const dev = store.deviceByToken(token, ip);
      if (!dev) {
        fail(ip);
        return send(res, 401, { error: "Телефон не подключён или отключён на ПК" });
      }
      if (store.expired(dev, deps.config().key_days)) {
        store.logAction(dev, "ключ истёк, телефон отключён");
        store.revoke(dev.id);
        deps.onChange();
        return send(res, 401, { error: "Срок ключа этого телефона истёк. Подключи его заново по QR-коду" });
      }
      if (ip === "TUNA") server.lastTunaConnection = new Date().toISOString();
      if (!allow(key === "POST /api/input" ? "input:" + dev.id : dev.id)) return send(res, 429, { error: "Слишком часто" });

      if (key === "GET /api/screenshot") {
        if (!deps.config().allow_screenshot) return send(res, 403, { error: "Снимок экрана выключен в настройках плагина" });
        const img = await pc.screenshot(Number(url.searchParams.get("screen")) || 0, Number(url.searchParams.get("w")) || 1600);
        store.logAction(dev, "снимок экрана");
        return send(res, 200, img, "image/jpeg");
      }

      if (key === "GET /api/avatar/model" || key === "GET /api/avatar/clip") {
        const file = key.endsWith("model") ? avatar.modelFile() : avatar.clipFile(url.searchParams.get("name"));
        const size = fs.statSync(file).size;
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size, "Cache-Control": "no-store" });
        const st = fs.createReadStream(file);
        st.on("error", () => res.destroy());
        return st.pipe(res);
      }

      if (key === "GET /api/library/search") {
        need("allow_file_search", "Поиск файлов не разрешён на ПК");
        searches.get(dev.id)?.abort();
        const controller = new AbortController(); searches.set(dev.id, controller);
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", abort);
        try {
          const result = await files.searchAllowed(deps.config(), { root: url.searchParams.get("root"), query: url.searchParams.get("q"), signal: controller.signal });
          need("allow_file_search", "Доступ к файлам отозван");
          if (!files.allowedRoots(deps.config()).some((r) => r.id === url.searchParams.get("root"))) throw httpError(403, "Доступ к папке отозван");
          if (!store.devices().some((d) => d.id === dev.id)) throw httpError(401, "Телефон отключён");
          return send(res, 200, result);
        } finally { res.removeListener("close", abort); if (searches.get(dev.id) === controller) searches.delete(dev.id); }
      }
      if (key === "GET /api/library/download") {
        need("allow_file_search", "Поиск файлов не разрешён на ПК");
        const file = files.openAllowedDownload(deps.config(), url.searchParams.get("root"), url.searchParams.get("path"));
        store.logAction(dev, "скачал из разрешённой папки: " + file.name);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": file.size, "Cache-Control": "no-store",
          "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.name) });
        file.stream.on("error", () => res.destroy());
        res.once("close", () => file.stream.destroy());
        return file.stream.pipe(res);
      }
      if (key === "GET /api/files/download") {
        need("allow_files", "Обмен файлами выключен в настройках плагина");
        const f = files.openForDownload(deps.config(), url.searchParams.get("path"));
        store.logAction(dev, "забрал файл " + f.name);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream", "Content-Length": f.size, "Cache-Control": "no-store",
          "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(f.name)
        });
        f.stream.on("error", () => res.destroy());
        return f.stream.pipe(res);
      }

      if (key === "POST /api/files/upload") {
        need("allow_files", "Обмен файлами выключен в настройках плагина");
        const cfg = deps.config();
        const r = await files.receive(cfg, req, url.searchParams.get("name"), files.maxBytes(cfg));
        store.logAction(dev, "прислал файл " + r.saved);
        deps.onUpload?.(r, dev);
        return send(res, 200, { saved: r.saved, size: r.size });
      }

      if (key === "POST /api/chat") {
        if (!deps.config().allow_chat) return send(res, 403, { error: "Чат выключен в настройках плагина" });
        const body = await readJson(req);
        const text = String(body.text || "").trim().slice(0, 4000);
        if (!text) return send(res, 400, { error: "empty" });
        store.logAction(dev, "сообщение в чат");
        // one JSON object per line, as the reply is written
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
        let closed = false;
        // Send a valid NDJSON heartbeat immediately and during silent model work.
        // This flushes the headers and keeps the phone/tunnel from timing out while Astra thinks.
        // Well under 3 s: APKs up to 0.8.2 keep their 3-second handshake limit as the read limit on
        // home Wi-Fi (Android ignores setReadTimeout after connect), and drop any pause longer than that.
        res.write('{"waiting":true}\n');
        const heartbeat = setInterval(() => {
          if (!closed && !res.writableNeedDrain) res.write('{"waiting":true}\n');
        }, 1500);
        res.on("close", () => { closed = true; clearInterval(heartbeat); });
        try {
          for await (const chunk of deps.chat(text, !!body.fresh, !!body.voice)) {
            if (closed) break;
            res.write(JSON.stringify(chunk) + "\n");
          }
        } catch (e) {
          if (!closed) res.write(JSON.stringify({ error: e.message || String(e) }) + "\n");
        } finally {
          clearInterval(heartbeat);
        }
        return res.end();
      }

      const route = routes[key];
      if (!route) return send(res, 404, { error: "not found" });
      const body = req.method === "POST" ? await readJson(req) : {};
      return send(res, 200, await route(body, dev, url));
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) });
      else res.end();
    }
  });

  installLanPolicy(server);
  const inputStream = attachInputStream(server, {
    authenticate(req) {
      const ip = ipOf(req);
      if (blocked(ip)) throw httpError(429, "Слишком много неудачных попыток");
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const dev = store.deviceByToken(token, ip);
      if (!dev) { fail(ip); throw httpError(401, "Телефон не подключён или отключён на ПК"); }
      if (store.expired(dev, deps.config().key_days)) throw httpError(401, "Срок ключа телефона истёк");
      if (ip === "TUNA") server.lastTunaConnection = new Date().toISOString();
      return dev;
    },
    enabled: () => !!deps.config().allow_input,
    input: (events) => pc.input(events),
    log(dev) {
      if (Date.now() - (inputLogged.get(dev.id) || 0) > 600000) store.logAction(dev, "тачпад и клавиатура");
      inputLogged.set(dev.id, Date.now());
    }
  });
  server.stopInputStream = inputStream.stop;
  server.reconcileRemote = () => {
    power.reconcile();
    if (!deps.config().allow_tasks) killChallenges.clear();
    if (!deps.config().allow_file_search) for (const controller of searches.values()) controller.abort();
  };
  server.stopRemote = () => {
    power.stop(); killChallenges.clear();
    for (const controller of searches.values()) controller.abort(); searches.clear();
  };
  server.once("close", server.stopRemote);
  server.requestTimeout = 0; // a chat reply may stream for minutes
  // the app keeps its connection between requests: through the relay a new one costs a tunnel and a TLS handshake
  server.keepAliveTimeout = 60000;
  server.headersTimeout = 20000;
  return server;
}
