// The avatar the phone shows: the model the worn character wears in Astra, and the VRMA motions of
// that character's own animation pack. Read from Astra's companion pack folder, never written.
// The phone downloads the model once (it asks by its SHA-256) and keeps it until it is unpaired.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const PACK = path.join(process.env.APPDATA || ".", "astra", "astra", "config", "companion", "pack");
const MAX_CLIP = 4 * 1024 * 1024; // a motion bigger than this is a dance video's worth of keys: not worth a phone's data

const get = (text, key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1] || "";
const hashes = new Map(); // file → { mtimeMs, size, sha }

function sha256(file) {
  const st = fs.statSync(file);
  const c = hashes.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.sha;
  const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  hashes.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha });
  return sha;
}

// the worn character: its name, model file and own pack folder (null when it is built in)
function worn() {
  const companion = fs.readFileSync(path.join(PACK, "companion.toml"), "utf8");
  const id = get(companion, "character");
  if (!id) return null;
  const text = fs.readFileSync(path.join(PACK, "characters", id, "character.toml"), "utf8");
  if (get(text, "kind") !== "vrm") return null;
  const model = get(text, "model");
  if (!model || model.includes(":")) return null; // a built-in body lives inside Astra's binary
  const animpack = get(text, "animpack");
  return {
    name: get(text, "name") || id,
    model: path.join(PACK, model),
    pack: animpack && !animpack.includes(":") ? path.join(PACK, "animpacks", animpack) : ""
  };
}

// the pack's VRMA motions: [[clips]] rows whose file is a .vrma of its own, small enough for a phone
function clips(packDir) {
  if (!packDir) return [];
  let text = "";
  try {
    text = fs.readFileSync(path.join(packDir, "animpack.toml"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const block of text.split(/^\[\[clips\]\]\s*$/m).slice(1)) {
    const name = get(block.split(/^\[/m)[0], "name"), file = get(block.split(/^\[/m)[0], "file");
    if (!name || !/\.vrma$/i.test(file) || file.includes(":")) continue;
    const full = path.join(packDir, file);
    try {
      const size = fs.statSync(full).size;
      if (size <= MAX_CLIP && !out.some((c) => c.name === name)) out.push({ name, size, file: full });
    } catch {}
  }
  return out;
}

// what the phone needs to know; null when the worn character has no model file of its own
export function info() {
  try {
    const w = worn();
    if (!w || !fs.existsSync(w.model)) return null;
    return {
      name: w.name, model: { size: fs.statSync(w.model).size, sha: sha256(w.model) },
      clips: clips(w.pack).map(({ name, size }) => ({ name, size }))
    };
  } catch {
    return null;
  }
}

export function modelFile() {
  const w = worn();
  if (!w || !fs.existsSync(w.model)) throw Object.assign(new Error("У персонажа нет своей модели"), { status: 404 });
  return w.model;
}

export function clipFile(name) {
  const c = clips(worn()?.pack).find((x) => x.name === String(name));
  if (!c) throw Object.assign(new Error("Нет такой анимации"), { status: 404 });
  return c.file;
}
