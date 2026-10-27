// @ts-nocheck — plain JavaScript in a .ts file: esbuild bundles it, nothing here is type-checked.
// Phone Remote — control this PC and talk to Astra from the Phone Remote phone app.
//
// The plugin is the bridge: Astra opens nothing to the network, and a plugin's token is good only for
// PluginHostService, so the plugin itself serves the app (src/server.js) and does the PC side
// (src/pc.js). From Astra it uses:
//   * SendChatMessage — the app's chat is a conversation with Astra;
//   * FireTrigger — buttons 1…12 in the app are this plugin's triggers; whatever Astra command the
//     user hangs on "Phone Remote: button N" runs on a tap;
//   * tools — Astra can send a file or folder to the phone and see what the phone sent (src/files.js).
// The plugin page in Astra pairs phones (QR code + "Allow"), names the buttons and lists what the
// phones did.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { plugin, tool, s } from "astra-plugin-sdk";
import { createServer, addresses, certFingerprint } from "./server.js";
import { startRelay } from "./relay.js";
import * as pc from "./pc.js";
import * as store from "./store.js";
import * as files from "./files.js";
import { qrSvg } from "./qr.js";

const DEFAULTS = {
  port: 8765, allow_chat: true, allow_screenshot: true, allow_power: true, allow_shutdown: false, confirm_shutdown: true,
  allow_files: true, shared_folder: "", max_upload_mb: 2048, allow_clipboard: true, allow_open_url: true, allow_input: true, allow_launch: true, voice_to_phone: true, voice_quiet_pc: true, key_days: 90,
  keep_awake: false, relay_url: ""
};

// "Don't sleep" holds only while at least one phone is paired: no phone, no reason to keep the PC up.
let awakeTimer = null;
function applyKeepAwake() {
  pc.keepAwake(!!config().keep_awake && store.devices().length > 0).catch(() => {});
}

let ctxRef = null;
let server = null;
let listening = { port: 0, error: "" };
let fingerprint = "";
let conversationId = ""; // the chat the app talks into; "" = this plugin's own thread

function config() {
  const c = ctxRef?.config || {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
  out.port = Math.max(1024, Math.min(65535, Number(out.port) || DEFAULTS.port));
  out.key_days = Math.max(0, Math.round(Number(out.key_days)) || 0);
  // the address saved on the plugin page wins; the settings field is the other way to give it
  out.relay_url = relayUrl(store.relayUrlSaved()) || relayUrl(out.relay_url);
  return out;
}

// "https://x.workers.dev" or "wss://…" → "wss://x.workers.dev"; anything else → "" (relay off)
function relayUrl(v) {
  const t = String(v || "").trim().replace(/\/+$/, "");
  if (!t) return "";
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : "https://" + t);
    if (!/^(https|wss):$/.test(u.protocol) || u.pathname !== "/" && u.pathname !== "") return "";
    return "wss://" + u.host;
  } catch {
    return "";
  }
}

// ── the relay: the way in from outside the home ─────────────────────────────
let relay = null, relayFor = "";
function applyRelay() {
  const url = config().relay_url;
  if (relay && relayFor === url) return;
  relay?.stop();
  relay = null;
  relayFor = url;
  if (!url) return;
  const { id, key } = store.relayIdentity();
  relay = startRelay({ url, id, key, port: () => listening.port, log: (m) => ctxRef?.info(m).catch(() => {}) });
}
// what the phone needs to come through it: the relay and this PC's id on it (no secret: the TLS pin is the check)
const relayInfo = () => (relay ? { url: relayFor, id: store.relayIdentity().id } : null);

// Astra grants a plugin's permissions only when the user ticks them in the install dialog; an
// install where they were left unticked runs with none, and Astra refuses the call (code 7).
const NO_GRANT = (what) => `Astra не дала плагину право ${what}. Разрешения выдаются только при установке: в Astra → Мастерская ` +
  "выключи Phone Remote, установи его заново и в окне установки отметь все разрешения.";

async function* chat(text, fresh, aloud = false) {
  if (fresh) conversationId = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      for await (const chunk of ctxRef.sendChatMessage(text, { conversationId, voiceEnabled: aloud })) {
        if (chunk.conversationId) conversationId = chunk.conversationId;
        if (chunk.error) {
          yield { error: chunk.error };
          return;
        }
        if (chunk.text) yield { text: chunk.text };
        if (chunk.done) break;
      }
      yield { done: true };
      return;
    } catch (e) {
      // the conversation was deleted in Astra: start a new one, once
      if (attempt === 0 && conversationId && (e.code === 5 || /conversation_gone/.test(e.message))) {
        conversationId = "";
        continue;
      }
      if (e.code === 7) throw new Error(NO_GRANT("писать в чат"));
      throw e;
    }
  }
}

// Astra's own voice on the phone. Astra is asked to speak the reply, as she would at the PC, and what
// her process (the daemon, this plugin's parent, with what it started) plays is recorded and sent with
// the text. The recording follows her volume on the PC, so she cannot be muted there; if so set, she
// is turned down to QUIET % for the reply and the recording turned up by as much.
// Lines: {voice: "start", rate}, the chat's own, {audio: base64 PCM}, and last {voiceEnd, heard, error}.
let voiceTurn = 0; // the reply whose voice is being recorded: a newer one takes the recorder over
async function* chatAloud(text, fresh) {
  const daemon = process.ppid;
  const turn = ++voiceTurn;
  try {
    await pc.voiceStart(daemon);
  } catch (e) {
    yield { voiceEnd: true, heard: false, error: e.message || String(e) };
    yield* chat(text, fresh);
    return;
  }
  yield { voice: "start", rate: pc.VOICE_RATE };
  const queue = [];
  let wake = null, chatDone = false;
  (async () => {
    try {
      for await (const c of chat(text, fresh, true)) { queue.push(c); wake?.(); }
    } catch (e) {
      queue.push({ error: e.message || String(e) });
    } finally {
      chatDone = true;
      wake?.();
    }
  })();
  const t0 = Date.now();
  let doneAt = 0, heard = false, lastLoud = 0, error = "";
  // her volume on the PC before she was turned down (null = left alone)
  let before = config().voice_quiet_pc ? await quietOnPc(daemon) : null;
  try {
    for (;;) {
      await new Promise((r) => { wake = r; setTimeout(r, 250); });
      wake = null;
      if (turn !== voiceTurn) break; // a newer reply has the recorder now
      while (queue.length) yield queue.shift();
      if (chatDone && !doneAt) doneAt = Date.now();
      const r = await pc.voiceRead();
      if (r.error) { error = r.error; break; }
      if (r.peak > 400) {
        lastLoud = Date.now();
        // no sound session yet when she was to be turned down at the start: now there is one
        if (!heard && before === null && config().voice_quiet_pc) before = await quietOnPc(daemon);
        heard = true;
      }
      if (heard && r.pcm) yield { audio: r.pcm };
      const now = Date.now();
      // she may start speaking a little after the text is done, and pause between sentences
      if (doneAt && (heard ? now - lastLoud > 1800 : now - doneAt > 12000)) break;
      if (now - t0 > 180000) break;
    }
  } finally {
    // the newer reply records on, and puts her volume back when it is done
    if (turn === voiceTurn) {
      await pc.voiceStop();
      if (before !== null) await loudAgain(daemon, before);
    }
  }
  yield { voiceEnd: true, heard, error };
}
const QUIET = 6; // %: hardly heard in the room, and enough left for a clean voice once turned up
// The volume to go back to is also kept in a file: a plugin stopped mid-reply puts it back on its next start.
const QUIET_FILE = path.join(store.DATA_DIR, "voice-volume.json");
let quietFrom = null; // her volume before a reply turned her down, while she is down
async function quietOnPc(pid) {
  if (quietFrom !== null) { // still down from the reply before: the recording is turned up again
    await pc.voiceGain(100 / QUIET).catch(() => {});
    return quietFrom;
  }
  try {
    const app = (await pc.appVolumes()).find((x) => x.pid === pid);
    if (!app || app.muted || app.volume <= QUIET) return null; // already silent or quiet: leave it
    fs.writeFileSync(QUIET_FILE, JSON.stringify({ pid, volume: app.volume }));
    await pc.setAppVolume({ pid, volume: QUIET });
    await pc.voiceGain(100 / QUIET);
    quietFrom = app.volume;
    return app.volume;
  } catch {
    return null;
  }
}
async function loudAgain(pid, volume) {
  quietFrom = null;
  await pc.setAppVolume({ pid, volume }).catch(() => {});
  try { fs.unlinkSync(QUIET_FILE); } catch {}
}
function loudAfterCrash() {
  try {
    const { pid, volume } = JSON.parse(fs.readFileSync(QUIET_FILE, "utf8"));
    if (pid === process.ppid) loudAgain(pid, volume);
    else fs.unlinkSync(QUIET_FILE);
  } catch {}
}

async function startServer() {
  const { port } = config();
  if (server && listening.port === port) return;
  stopServer();
  try {
    await pc.ensureCertificate(store.PFX, store.tlsPass());
    fingerprint = certFingerprint();
  } catch (e) {
    listening = { port: 0, error: "Не удалось создать сертификат: " + e.message };
    return;
  }
  const s = createServer({
    config,
    fireButton: (n) => ctxRef.fireTrigger(`button_${n}`, { button: String(n) }).catch((e) => {
      throw e.code === 7 ? new Error(NO_GRANT("запускать команды кнопками")) : e;
    }),
    chat: (text, fresh, aloud) => (aloud && config().voice_to_phone ? chatAloud(text, fresh) : chat(text, fresh)),
    relay: relayInfo,
    onChange: () => {}
  });
  server = s;
  s.on("error", (e) => {
    listening = { port: 0, error: e.code === "EADDRINUSE" ? `Порт ${port} уже занят — поменяй его в настройках плагина` : e.message };
    ctxRef?.warn(`server: ${e.message}`).catch(() => {});
  });
  s.listen(port, "0.0.0.0", () => {
    listening = { port, error: "" };
    ctxRef?.info(`listening on ${port}`).catch(() => {});
  });
}

function stopServer() {
  if (server) server.close();
  server = null;
  listening = { port: 0, error: "" };
}

function sharedFolder() {
  try {
    return config().allow_files ? files.root(config()) : "";
  } catch (e) {
    return "";
  }
}

function pageState(ctx) {
  const active = [...(ctx?.activeTriggers || [])];
  return {
    // not "error": the SDK takes an object with an "error" key for a { resultJson, error } wrapper and drops the rest
    port: listening.port, serverError: listening.error, addresses: addresses(), config: config(), fingerprint,
    relay: relay ? { url: relayFor, ...relay.state() } : null,
    relayId: store.relayIdentity().id, // for a private relay's ALLOWED_PCS (relay/README.md)
    pairing: store.pairState(), actions: store.recentActions(), folder: sharedFolder(),
    devices: store.devices().map((d) => ({ ...d, expires: store.expiresAt(d, config().key_days) })),
    buttons: store.buttons().map((b) => ({ ...b, bound: active.some((a) => a === `button_${b.n}` || a.endsWith(`__button_${b.n}`)) }))
  };
}

// What the QR code carries: every address of this PC, the port, the certificate to trust and the
// one-time secret. The app reads it with its own scanner; it is not a web link.
function pairLink(secret) {
  const q = new URLSearchParams({
    v: "1", h: addresses().map((a) => a.address).join(","), p: String(listening.port), f: fingerprint, s: secret, n: os.hostname()
  });
  // The relay is not in it: its address would make the code too dense for a phone camera, and the
  // phone learns it from /api/state right after pairing, over the pinned connection.
  return "astraremote://pair?" + q.toString();
}

const triggers = {};
for (let n = 1; n <= store.BUTTON_COUNT; n++) {
  triggers[`button_${n}`] = { label: `Phone Remote: кнопка ${n} на телефоне`, fields: [] };
}

export const app = plugin({
  id: "phone-remote",
  triggers,
  tools: {
    send_file_to_phone: tool({
      description: "Send a file or a whole folder from this PC to the user's phone (the Phone Remote app). Use when the user asks to send, share or drop a file to their phone. The file is copied into the Phone Remote shared folder and shows up in the app under Files.",
      input: s.object({ path: s.string({ description: "Full path of the file or folder on this PC" }) }),
      run: ({ path: p }) => {
        if (!config().allow_files) throw new Error("File sharing is turned off in the Phone Remote settings");
        if (!store.devices().length) throw new Error("No phone is paired with Phone Remote yet");
        const items = files.offer(config(), p);
        store.addSent(items);
        store.logAction({ name: "Astra" }, `отправила на телефон: ${items.length === 1 ? items[0].name : items.length + " файлов"}`);
        return `Sent ${items.length} file(s) to the phone: ${items.slice(0, 10).map((x) => x.name).join(", ")}${items.length > 10 ? "…" : ""}. They are in the Phone Remote app under Files.`;
      }
    }),
    notify_phone: tool({
      description: "Show a notification on the user's phone (the Phone Remote app). Use when the user asks to be told or reminded of something on their phone, or to get a message there when a task finishes.",
      input: s.object({
        text: s.string({ description: "The notification text, short" }),
        title: s.string({ description: "Optional title; default \"Astra\"" }).optional()
      }),
      run: ({ text, title }) => {
        if (!store.devices().length) throw new Error("No phone is paired with Phone Remote yet");
        store.addNote(title || "Astra", text);
        store.logAction({ name: "Astra" }, "уведомление на телефон");
        return "The notification is queued for the phone. It shows as soon as the app checks in (at once while it is open, otherwise within about 15 minutes).";
      }
    }),
    list_phone_uploads: tool({
      description: "List the files the user recently sent from their phone to this PC with the Phone Remote app (newest first), with full paths, so you can open or work with them.",
      run: () => {
        if (!config().allow_files) throw new Error("File sharing is turned off in the Phone Remote settings");
        return { folder: files.root(config()), from_phone: files.recentUploads(config()) };
      }
    })
  },
  // SendChatMessage sits under the `client` capability; the DaemonClient it brings is unusable to a
  // plugin (every call is permission_denied) and is not touched
  client: {},
  onStart: async (ctx) => {
    ctxRef = ctx;
    store.load();
    pc.warmUp();
    loudAfterCrash();
    applyKeepAwake();
    awakeTimer = setInterval(applyKeepAwake, 4 * 60 * 1000);
    await startServer();
    applyRelay();
  },
  onConfigChanged: async (_cfg, ctx) => {
    ctxRef = ctx;
    await startServer();
    applyRelay();
    applyKeepAwake();
  },
  onShutdown: async () => {
    // each step on its own: one that throws must not keep the process (and Astra's reinstall) waiting
    for (const step of [() => clearInterval(awakeTimer), () => relay?.stop(), stopServer, pc.stopWorker]) {
      try { step(); } catch {}
    }
    // and out, even if something still holds the event loop: Astra refuses a reinstall while we run
    setTimeout(() => process.exit(0), 1500).unref();
  },
  ui: {
    contributions: [{
      id: "phone-remote", slot: "page.custom", label: "Phone Remote",
      iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/><path d="M9.5 9.5a3.5 3.5 0 0 1 5 0M8 7.5a6 6 0 0 1 8 0"/></svg>',
      url: "index.html", width: 0, height: 0, transparent: true
    }],
    onCall: {
      getState: async (_p, ctx) => {
        ctxRef = ctx;
        return pageState(ctx);
      },
      startPairing: async (_p, ctx) => {
        if (!listening.port) throw new Error(listening.error || "Сервер ещё не запущен");
        const { secret } = store.startPairing();
        return { ...pageState(ctx), qr: qrSvg(pairLink(secret)) };
      },
      cancelPairing: async (_p, ctx) => {
        store.cancelPairing();
        return pageState(ctx);
      },
      answerPairing: async (p, ctx) => {
        store.answerPairing(String(p.id), !!p.allow);
        applyKeepAwake();
        return pageState(ctx);
      },
      revoke: async (p, ctx) => {
        store.revoke(String(p.id));
        applyKeepAwake();
        return pageState(ctx);
      },
      updateDevice: async (p, ctx) => {
        store.updateDevice(String(p.id), p.patch || {});
        return pageState(ctx);
      },
      setButton: async (p, ctx) => {
        store.setButton(p.n, p.patch || {});
        return pageState(ctx);
      },
      // the relay address from the plugin page: "" turns it off
      setRelay: async (p, ctx) => {
        const raw = String(p.url || "").trim();
        if (raw && !relayUrl(raw)) throw new Error("Это не похоже на адрес ретранслятора: нужен https://…workers.dev");
        store.saveRelayUrl(raw);
        applyRelay();
        return pageState(ctx);
      },
      // a link from the plugin page (the Deploy to Cloudflare button), in the default browser
      openUrl: async (p) => {
        const url = String(p.url || "");
        if (!/^https:\/\/(deploy\.workers\.cloudflare\.com|github\.com|dash\.cloudflare\.com)\//.test(url)) throw new Error("Эту ссылку плагин не открывает");
        await pc.openUrl(url);
        return true;
      },
      openFolder: async () => {
        const f = sharedFolder();
        if (!f) throw new Error("Обмен файлами выключен в настройках плагина");
        pc.openFolder(f);
        return true;
      },
      testButton: async (p, ctx) => {
        await ctx.fireTrigger(`button_${Number(p.n)}`, { button: String(p.n) });
        return true;
      }
    }
  }
});

app.run();
