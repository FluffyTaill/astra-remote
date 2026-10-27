// Paired phones, pairing requests, the buttons and the action log.
// Kept outside the plugin folder: Astra checks that folder's files against MANIFEST.json.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const DATA_DIR = path.join(process.env.APPDATA || ".", "astra-remote");
const DB = path.join(DATA_DIR, "remote.json");
const LOG = path.join(DATA_DIR, "actions.log");
export const PFX = path.join(DATA_DIR, "tls.pfx");

export const BUTTON_COUNT = 12;
const PAIR_TTL_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 3;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function defaults() {
  return {
    devices: [], // { id, name, hash (sha256 of the token), created, lastSeen, lastIp }
    buttons: Array.from({ length: BUTTON_COUNT }, (_, i) => ({ n: i + 1, label: "", icon: "" })),
    sent: [], // { path (inside the shared folder), name, size, at }: what Astra sent to the phone
    tls: { pass: crypto.randomBytes(24).toString("hex") }
  };
}

let db = null;

export function load() {
  if (db) return db;
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {}
  db = { ...defaults(), ...(saved || {}) };
  if (!saved) save();
  return db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB);
}

export const tlsPass = () => load().tls.pass;

// The relay this PC uses, as set on the plugin page ("" = none). Each user runs their own (relay/README.md).
const RELAY_FILE = path.join(DATA_DIR, "relay.json");
export function relayUrlSaved() {
  try {
    return String(JSON.parse(fs.readFileSync(RELAY_FILE, "utf8")).url || "");
  } catch {
    return "";
  }
}
export function saveRelayUrl(url) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RELAY_FILE, JSON.stringify({ url: String(url || "") }, null, 2));
}

// This PC on the relay: the id phones ask for, and the key only this PC knows (the relay keeps its hash).
export function relayIdentity() {
  load();
  if (!db.relay) {
    db.relay = { id: crypto.randomBytes(16).toString("hex"), key: crypto.randomBytes(32).toString("hex") };
    save();
  }
  return db.relay;
}

// ── pairing ─────────────────────────────────────────────────────────────────
// The secret is only in the QR code on the plugin page; a phone that has it still gets no key until
// the owner presses "Allow" on that page.
let pairing = null; // { secret, until, requests: [{ id, poll, name, ip, check, status, token }] }

export function startPairing() {
  pairing = { secret: crypto.randomBytes(32).toString("base64url"), until: Date.now() + PAIR_TTL_MS, requests: [] };
  return { secret: pairing.secret, until: pairing.until };
}

export function cancelPairing() {
  pairing = null;
}

function livePairing() {
  if (pairing && Date.now() > pairing.until) pairing = null;
  return pairing;
}

export function pairState() {
  const p = livePairing();
  if (!p) return null;
  return {
    until: p.until,
    requests: p.requests.filter((r) => r.status === "wait").map(({ id, name, ip, check }) => ({ id, name, ip, check }))
  };
}

// A phone with the secret asks to be paired. Returns what it polls with, and a 4-digit check
// code it shows so the owner can tell it is the phone in their hand.
export function requestPairing(secret, name, ip) {
  const p = livePairing();
  if (!p || p.closed || !same(secret, p.secret)) return { error: "bad_secret" };
  if (p.requests.length >= MAX_REQUESTS) return { error: "too_many" };
  const req = {
    id: crypto.randomUUID(), poll: crypto.randomBytes(24).toString("base64url"),
    name: String(name || "Телефон").replace(/[\r\n\t]/g, " ").slice(0, 40), ip,
    check: String(crypto.randomInt(0, 10000)).padStart(4, "0"), status: "wait", token: ""
  };
  p.requests.push(req);
  return { id: req.id, poll: req.poll, check: req.check };
}

// The phone polls; once allowed it gets its key exactly once.
export function pollPairing(id, poll) {
  const p = livePairing();
  const req = p?.requests.find((r) => r.id === id);
  if (!req || !same(poll, req.poll)) return { status: "gone" };
  if (req.status === "denied") p.requests = p.requests.filter((r) => r !== req);
  if (req.status !== "ok") return { status: req.status };
  const token = req.token;
  p.requests = p.requests.filter((r) => r !== req);
  if (!p.requests.length) pairing = null; // done: the QR code stops working
  return { status: "ok", token };
}

// The owner's answer on the plugin page.
export function answerPairing(id, allow) {
  const p = livePairing();
  const req = p?.requests.find((r) => r.id === id && r.status === "wait");
  if (!req) return null;
  if (!allow) {
    req.status = "denied";
    return null;
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const device = { id: crypto.randomUUID(), name: req.name, hash: sha(token), created: now, lastSeen: now, lastIp: req.ip };
  load().devices.push(device);
  save();
  req.status = "ok";
  req.token = token;
  p.closed = true; // the QR code is spent: no one else can ask with it
  // one phone per QR code: the other requests are turned away
  for (const r of p.requests) if (r !== req && r.status === "wait") r.status = "denied";
  return publicDevice(device);
}

// ── devices ─────────────────────────────────────────────────────────────────

// The device a key belongs to, or null. Saves when it was last seen at most once a minute.
export function deviceByToken(token, ip) {
  if (!token) return null;
  const h = sha(token);
  const d = load().devices.find((x) => same(x.hash, h));
  if (!d) return null;
  const now = Date.now();
  if (now - Date.parse(d.lastSeen) > 60000 || d.lastIp !== ip) {
    d.lastSeen = new Date(now).toISOString();
    d.lastIp = ip;
    save();
  }
  return d;
}

const publicDevice = ({ id, name, created, lastSeen, lastIp }) => ({ id, name, created, lastSeen, lastIp });

// A key lasts `days` from pairing (0 = for good); then the phone pairs again by QR code.
export function expiresAt(device, days) {
  return days > 0 ? new Date(Date.parse(device.created) + days * 86400000).toISOString() : null;
}

export function expired(device, days) {
  const at = expiresAt(device, days);
  return !!at && Date.now() > Date.parse(at);
}

export function devices() {
  return load().devices.map(publicDevice);
}

export function revoke(id) {
  const d = load();
  d.devices = d.devices.filter((x) => x.id !== id);
  save();
}

export function updateDevice(id, patch) {
  const dev = load().devices.find((x) => x.id === id);
  if (!dev) return;
  if ("name" in patch) dev.name = String(patch.name).slice(0, 40);
  save();
}

// ── buttons ─────────────────────────────────────────────────────────────────

export function buttons() {
  return load().buttons;
}

export function setButton(n, patch) {
  const b = load().buttons.find((x) => x.n === Number(n));
  if (!b) throw new Error("no such button");
  if ("label" in patch) b.label = String(patch.label).slice(0, 30);
  if ("icon" in patch) b.icon = String(patch.icon).slice(0, 4);
  save();
  return b;
}

// ── files Astra sent to the phone ───────────────────────────────────────────

export function addSent(items) {
  const at = new Date().toISOString();
  const d = load();
  d.sent = [...items.map((x) => ({ ...x, at })), ...(d.sent || [])].slice(0, 30);
  save();
}

export function sent() {
  return load().sent || [];
}

// ── notes for the phone ─────────────────────────────────────────────────────
// What Astra asked to tell the phone (the notify_phone tool), newest first. The app shows each as an
// Android notification once: it remembers the newest id it has seen.
export function addNote(title, text) {
  const d = load();
  const id = (d.notes?.[0]?.id || 0) + 1;
  d.notes = [{ id, title: String(title || "Astra").slice(0, 80), text: String(text || "").slice(0, 1000), at: new Date().toISOString() }, ...(d.notes || [])].slice(0, 50);
  save();
  return id;
}

export function notes() {
  return load().notes || [];
}

// ── action log ──────────────────────────────────────────────────────────────
// What each phone did and when, one line each. Chat text and typed text are not written down.
const recent = [];

export function logAction(device, action, ok = true) {
  const entry = { at: new Date().toISOString(), device: device?.name || "?", action, ok };
  recent.unshift(entry);
  recent.length = Math.min(recent.length, 200);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG, `${entry.at}\t${entry.device}\t${action}\t${ok ? "ok" : "fail"}\n`);
    if (fs.statSync(LOG).size > 1 << 20) fs.renameSync(LOG, LOG + ".old");
  } catch {}
}

export function recentActions() {
  return recent.slice(0, 50);
}
