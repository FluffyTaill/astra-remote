// @ts-nocheck — plain JavaScript in a .ts file: esbuild bundles it, nothing here is type-checked.
// Astra Remote — control this PC and talk to Astra from the Astra Remote phone app.
//
// The plugin is the bridge: Astra opens nothing to the network, and a plugin's token is good only for
// PluginHostService, so the plugin itself serves the app (src/server.js) and does the PC side
// (src/pc.js). From Astra it uses:
//   * SendChatMessage — the app's chat is a conversation with Astra;
//   * FireTrigger — buttons 1…12 in the app are this plugin's triggers; whatever Astra command the
//     user hangs on "Astra Remote: button N" runs on a tap;
//   * tools — Astra can send a file or folder to the phone and see what the phone sent (src/files.js).
// The plugin page in Astra pairs phones (QR code + "Allow"), names the buttons and lists what the
// phones did.
import * as os from "node:os";
import { plugin, tool, s } from "astra-plugin-sdk";
import { createServer, addresses, certFingerprint } from "./server.js";
import * as pc from "./pc.js";
import * as store from "./store.js";
import * as files from "./files.js";
import { qrSvg } from "./qr.js";

const DEFAULTS = {
  port: 8765, allow_chat: true, allow_screenshot: true, allow_power: true, allow_shutdown: false, confirm_shutdown: true,
  allow_files: true, shared_folder: "", max_upload_mb: 2048, allow_clipboard: true, allow_open_url: true, key_days: 90
};

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
  return out;
}

async function* chat(text, fresh) {
  if (fresh) conversationId = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      for await (const chunk of ctxRef.sendChatMessage(text, { conversationId })) {
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
      if (e.code === 7) throw new Error("Astra не разрешила плагину писать в чат: выдай разрешение «Отправка сообщений в чат» в настройках плагина");
      throw e;
    }
  }
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
    fireButton: (n) => ctxRef.fireTrigger(`button_${n}`, { button: String(n) }),
    chat,
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
    port: listening.port, error: listening.error, addresses: addresses(), config: config(), fingerprint,
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
  return "astraremote://pair?" + q.toString();
}

const triggers = {};
for (let n = 1; n <= store.BUTTON_COUNT; n++) {
  triggers[`button_${n}`] = { label: `Astra Remote: кнопка ${n} на телефоне`, fields: [] };
}

export const app = plugin({
  id: "astra-remote",
  triggers,
  tools: {
    send_file_to_phone: tool({
      description: "Send a file or a whole folder from this PC to the user's phone (the Astra Remote app). Use when the user asks to send, share or drop a file to their phone. The file is copied into the Astra Remote shared folder and shows up in the app under Files.",
      input: s.object({ path: s.string({ description: "Full path of the file or folder on this PC" }) }),
      run: ({ path: p }) => {
        if (!config().allow_files) throw new Error("File sharing is turned off in the Astra Remote settings");
        if (!store.devices().length) throw new Error("No phone is paired with Astra Remote yet");
        const items = files.offer(config(), p);
        store.addSent(items);
        store.logAction({ name: "Astra" }, `отправила на телефон: ${items.length === 1 ? items[0].name : items.length + " файлов"}`);
        return `Sent ${items.length} file(s) to the phone: ${items.slice(0, 10).map((x) => x.name).join(", ")}${items.length > 10 ? "…" : ""}. They are in the Astra Remote app under Files.`;
      }
    }),
    list_phone_uploads: tool({
      description: "List the files the user recently sent from their phone to this PC with the Astra Remote app (newest first), with full paths, so you can open or work with them.",
      run: () => {
        if (!config().allow_files) throw new Error("File sharing is turned off in the Astra Remote settings");
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
    await startServer();
  },
  onConfigChanged: async (_cfg, ctx) => {
    ctxRef = ctx;
    await startServer();
  },
  onShutdown: async () => {
    stopServer();
    pc.stopWorker();
  },
  ui: {
    contributions: [{
      id: "astra-remote", slot: "page.custom", label: "Astra Remote",
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
        return pageState(ctx);
      },
      revoke: async (p, ctx) => {
        store.revoke(String(p.id));
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
      testButton: async (p, ctx) => {
        await ctx.fireTrigger(`button_${Number(p.n)}`, { button: String(p.n) });
        return true;
      }
    }
  }
});

app.run();
