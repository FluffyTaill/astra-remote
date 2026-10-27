// The shared folder: what the phone can see on this PC, and nothing else.
//   <folder>\С телефона  — files sent from the phone land here
//   <folder>\Для телефона — files Astra sends to the phone (the send_file_to_phone tool) are copied here
// Astra sees the folder like any other, so "look at what I sent from the phone" works too.
// Every path from the phone is resolved inside the folder and checked again after following links.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FROM_PHONE = "С телефона";
export const FOR_PHONE = "Для телефона";

const httpError = (status, message) => Object.assign(new Error(message), { status });

export function root(cfg) {
  const dir = String(cfg.shared_folder || "").trim() || path.join(os.homedir(), "Astra Remote");
  for (const sub of ["", FROM_PHONE, FOR_PHONE]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return fs.realpathSync(dir);
}

// A path from the phone ("a/b.txt") → an absolute path inside the folder, or a 400/404.
function inside(base, rel) {
  rel = String(rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (rel.split("/").some((p) => p === ".." || p === "." || /[\x00-\x1f:*?"<>|]/.test(p))) throw httpError(400, "Недопустимый путь");
  const full = path.resolve(base, rel);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw httpError(404, "Такого файла уже нет");
  }
  if (real !== base && !real.startsWith(base + path.sep)) throw httpError(403, "Файл вне общей папки");
  return { full: real, rel };
}

export function list(cfg, rel) {
  const base = root(cfg);
  const { full, rel: clean } = inside(base, rel);
  if (!fs.statSync(full).isDirectory()) throw httpError(400, "Это не папка");
  const items = [];
  for (const d of fs.readdirSync(full, { withFileTypes: true })) {
    if (d.name.startsWith(".") || /^desktop\.ini$/i.test(d.name) || /\.part$/.test(d.name)) continue;
    try {
      const st = fs.statSync(path.join(full, d.name));
      items.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtime.toISOString() });
    } catch {}
  }
  // folders first, then the newest
  items.sort((a, b) => Number(b.dir) - Number(a.dir) || (a.dir ? a.name.localeCompare(b.name) : b.mtime.localeCompare(a.mtime)));
  return { root: path.basename(base), folder: base, path: clean, items: items.slice(0, 500), maxBytes: maxBytes(cfg) };
}

// A folder inside the shared one, for opening it in Explorer on the PC.
export function resolveDir(cfg, rel) {
  const { full } = inside(root(cfg), rel);
  if (!fs.statSync(full).isDirectory()) throw httpError(400, "Это не папка");
  return full;
}

export function openForDownload(cfg, rel) {
  const { full } = inside(root(cfg), rel);
  const st = fs.statSync(full);
  if (!st.isFile()) throw httpError(400, "Это не файл");
  return { stream: fs.createReadStream(full), size: st.size, name: path.basename(full) };
}

function safeName(name) {
  const s = String(name || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 180);
  return s || "file";
}

function unique(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// The request body is the file. Written to a .part first, so a broken upload never looks like a file.
// Past the limit the rest is read and dropped, so the phone still gets a clear answer, not a reset.
export function receive(cfg, req, name, maxBytes) {
  const tooBig = () => httpError(413, `Файл больше ${Math.round(maxBytes / 1048576)} МБ — лимит в настройках плагина`);
  if (Number(req.headers["content-length"]) > maxBytes) {
    req.resume();
    return Promise.reject(tooBig());
  }
  const dir = path.join(root(cfg), FROM_PHONE);
  const target = unique(dir, safeName(name));
  const part = target + ".part";
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    let size = 0, over = false, settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      out.destroy();
      out.once("close", () => fs.rmSync(part, { force: true }));
      reject(e);
    };
    req.on("data", (c) => {
      if (over || settled) return;
      size += c.length;
      if (size > maxBytes) {
        over = true;
        return;
      }
      if (!out.write(c)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    });
    req.on("end", () => {
      if (over) return fail(tooBig());
      out.end(() => {
        if (settled) return;
        try {
          fs.renameSync(part, target);
          settled = true;
          resolve({ saved: FROM_PHONE + "/" + path.basename(target), full: target, size });
        } catch (e) {
          fail(e);
        }
      });
    });
    req.on("close", () => { if (!req.complete) fail(httpError(400, "Передача прервалась")); });
    out.on("error", (e) => fail(e));
  });
}

export const maxBytes = (cfg) => Math.max(1, Number(cfg.max_upload_mb) || 2048) * 1048576;

// What the phone sent, newest first: for Astra's list_phone_uploads tool.
export function recentUploads(cfg, n = 20) {
  const dir = path.join(root(cfg), FROM_PHONE);
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && !d.name.endsWith(".part"))
    .map((d) => {
      const st = fs.statSync(path.join(dir, d.name));
      return { path: path.join(dir, d.name), size: st.size, received: st.mtime.toISOString() };
    })
    .sort((a, b) => b.received.localeCompare(a.received)).slice(0, n);
}

const MAX_FILES = 300;
const MAX_TOTAL = 4 * 2 ** 30;

// Put a file or folder from anywhere on the PC where the phone can take it. A file already in the
// shared folder is offered as it is; anything else is copied into "Для телефона".
// Returns the files the phone should be told about, as paths relative to the folder.
export function offer(cfg, src) {
  const base = root(cfg);
  let real;
  try {
    real = fs.realpathSync(String(src || ""));
  } catch {
    throw new Error("Нет такого файла или папки: " + src);
  }
  const rel = (p) => path.relative(base, p).split(path.sep).join("/");
  const walk = (dir, out) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, out);
      else if (d.isFile()) out.push(p);
      if (out.length > MAX_FILES) throw new Error(`В папке больше ${MAX_FILES} файлов — отправь её частями или архивом`);
    }
    return out;
  };
  const isDir = fs.statSync(real).isDirectory();
  const files = isDir ? walk(real, []) : [real];
  const total = files.reduce((s, f) => s + fs.statSync(f).size, 0);
  if (total > MAX_TOTAL) throw new Error("Больше 4 ГБ — слишком много для телефона за раз");
  if (real === base || real.startsWith(base + path.sep)) {
    return files.map((f) => ({ path: rel(f), name: path.basename(f), size: fs.statSync(f).size }));
  }
  const target = unique(path.join(base, FOR_PHONE), path.basename(real));
  if (isDir) fs.cpSync(real, target, { recursive: true });
  else fs.copyFileSync(real, target);
  const copied = isDir ? walk(target, []) : [target];
  return copied.map((f) => ({ path: rel(f), name: path.basename(f), size: fs.statSync(f).size }));
}
