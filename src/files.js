// The shared folder: what the phone can see on this PC, and nothing else.
//   <folder>\С телефона  — files sent from the phone land here
//   <folder>\Для телефона — files Astra sends to the phone (the send_file_to_phone tool) are copied here
// Astra sees the folder like any other, so "look at what I sent from the phone" works too.
// Every path from the phone is resolved inside the folder and checked again after following links.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FROM_PHONE = "С телефона";
export const FOR_PHONE = "Для телефона";

const httpError = (status, message) => Object.assign(new Error(message), { status });
const pathError = () => httpError(400, "Недопустимый путь");
const hiddenEntry = (name) => name.startsWith(".") || /^desktop\.ini$/i.test(name) || /\.part$/i.test(name);

export function root(cfg) {
  const dir = String(cfg.shared_folder || "").trim() || path.join(os.homedir(), "Astra Remote");
  for (const sub of ["", FROM_PHONE, FOR_PHONE]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return fs.realpathSync(dir);
}

// Phone paths are deliberately checked as Windows paths too, even when this runs on another OS.
function cleanRelative(rel) {
  if (rel === undefined || rel === null || rel === "") return "";
  if (typeof rel !== "string") throw pathError();
  if (/^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel) || /[\x00-\x1f\x7f]/.test(rel)) throw pathError();
  const parts = rel.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[:*?"<>|]/.test(part))) throw pathError();
  return parts.join("/");
}

function contained(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
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
    if (hiddenEntry(d.name)) continue;
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

// Read-only configured folders. These APIs never call root(), so merely browsing cannot create a folder.
const LIST_LIMIT = 500;
const SEARCH_LIMITS = { results: 300, visited: 20000, depth: 12, timeMs: 3000 };
let activeSearches = 0;

function rootId(real) {
  // realpath is canonical for the host; the digest keeps it out of phone-facing responses.
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 24);
}

function rootName(real) {
  return path.basename(real) || "root";
}

function configuredRoots(cfg) {
  const found = new Map();
  for (const line of String(cfg?.allowed_folders || "").split(/\r?\n/)) {
    const configured = line.trim();
    if (!configured) continue;
    try {
      const real = fs.realpathSync(configured);
      if (!fs.statSync(real).isDirectory()) continue;
      const id = rootId(real);
      if (!found.has(id)) found.set(id, { id, name: rootName(real), real });
    } catch {
      // A stale or inaccessible configured path is simply unavailable.
    }
  }
  return [...found.values()];
}

// Returns only stable opaque IDs and display names; paths never cross the phone boundary.
export function allowedRoots(cfg) {
  return configuredRoots(cfg).map(({ id, name }) => ({ id, name }));
}

function selectedRoot(cfg, id) {
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) throw httpError(404, "Неизвестная папка");
  const selected = configuredRoots(cfg).find((entry) => entry.id === id);
  if (!selected) throw httpError(404, "Неизвестная папка");
  return selected;
}

function allowedInside(base, rel) {
  const clean = cleanRelative(rel);
  let full;
  try {
    full = fs.realpathSync(path.resolve(base, clean));
  } catch {
    throw httpError(404, "Такого файла уже нет");
  }
  // Re-check the selected root as well: config roots can be replaced between requests.
  let currentRoot;
  try {
    currentRoot = fs.realpathSync(base);
  } catch {
    throw httpError(404, "Папка больше недоступна");
  }
  if (currentRoot !== base || !contained(base, full)) throw httpError(403, "Файл вне разрешённой папки");
  return { full, rel: clean };
}

function entryInfo(base, parent, dirent) {
  if (hiddenEntry(dirent.name)) return null;
  try {
    const real = fs.realpathSync(path.join(parent, dirent.name));
    if (!contained(base, real)) return null; // symlink or junction that leaves the configured root
    const st = fs.statSync(real);
    return { real, st };
  } catch {
    return null;
  }
}

function itemFrom(name, st) {
  return { name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtime.toISOString() };
}

export function listAllowed(cfg, id, rel = "") {
  const selected = selectedRoot(cfg, id);
  const { full, rel: clean } = allowedInside(selected.real, rel);
  if (!fs.statSync(full).isDirectory()) throw httpError(400, "Это не папка");
  const items = [];
  let truncated = false;
  for (const dirent of fs.readdirSync(full, { withFileTypes: true })) {
    const info = entryInfo(selected.real, full, dirent);
    if (!info) continue;
    if (items.length >= LIST_LIMIT) {
      truncated = true;
      break;
    }
    items.push(itemFrom(dirent.name, info.st));
  }
  items.sort((a, b) => Number(b.dir) - Number(a.dir) || (a.dir ? a.name.localeCompare(b.name) : b.mtime.localeCompare(a.mtime)));
  return { root: selected.id, path: clean, items, truncated };
}

function abortError() {
  return Object.assign(new Error("Поиск отменён"), { name: "AbortError", code: "ABORT_ERR" });
}

function budget(value, fallback, ceiling, minimum = 1) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(ceiling, Math.max(minimum, Math.floor(number)));
}

// Search is asynchronous so aborts and other requests get a turn between batches.
export async function searchAllowed(cfg, options = {}) {
  const { root: id, query, signal } = options;
  if (typeof query !== "string" || !query.trim() || query.length > 256 || /[\x00-\x1f\x7f]/.test(query)) throw httpError(400, "Недопустимый запрос");
  if (signal?.aborted) throw abortError();
  if (activeSearches >= 2) throw httpError(429, "Слишком много поисков");

  const selected = selectedRoot(cfg, id);
  const maxResults = budget(options.maxResults, SEARCH_LIMITS.results, SEARCH_LIMITS.results);
  const maxVisited = budget(options.maxVisited, SEARCH_LIMITS.visited, SEARCH_LIMITS.visited);
  const maxDepth = budget(options.maxDepth, SEARCH_LIMITS.depth, SEARCH_LIMITS.depth, 0);
  const timeoutMs = budget(options.timeoutMs, SEARCH_LIMITS.timeMs, SEARCH_LIMITS.timeMs);
  const needle = query.trim().toLocaleLowerCase();
  const items = [];
  let visited = 0;
  let truncated = false;
  const started = Date.now();
  const queue = [{ full: selected.real, rel: "", depth: 0 }];
  const seenDirectories = new Set([selected.real]);

  activeSearches++;
  try {
    while (queue.length && !truncated) {
      if (signal?.aborted) throw abortError();
      if (Date.now() - started >= timeoutMs) {
        truncated = true;
        break;
      }
      const current = queue.shift();
      // A directory may have been changed after it was queued.
      let currentReal;
      try {
        currentReal = fs.realpathSync(current.full);
      } catch {
        continue;
      }
      if (!contained(selected.real, currentReal)) continue;

      let entries;
      try {
        entries = fs.readdirSync(currentReal, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of entries) {
        if (signal?.aborted) throw abortError();
        if (Date.now() - started >= timeoutMs) {
          truncated = true;
          break;
        }
        if (++visited > maxVisited) {
          truncated = true;
          break;
        }
        const info = entryInfo(selected.real, currentReal, dirent);
        if (!info) continue;
        const childRel = current.rel ? current.rel + "/" + dirent.name : dirent.name;
        if (info.st.isDirectory()) {
          if (current.depth >= maxDepth) truncated = true;
          else if (!seenDirectories.has(info.real)) {
            seenDirectories.add(info.real);
            queue.push({ full: info.real, rel: childRel, depth: current.depth + 1 });
          }
        } else if (info.st.isFile() && dirent.name.toLocaleLowerCase().includes(needle)) {
          items.push({ name: dirent.name, path: childRel, root: selected.id, dir: false, size: info.st.size, mtime: info.st.mtime.toISOString() });
          if (items.length >= maxResults) {
            truncated = true;
            break;
          }
        }
        if (visited % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    activeSearches--;
  }
  return { items, truncated };
}

export function openAllowedDownload(cfg, id, rel = "") {
  const selected = selectedRoot(cfg, id);
  const { full } = allowedInside(selected.real, rel);
  const checked = fs.statSync(full);
  if (!checked.isFile()) throw httpError(400, "Это не файл");

  let fd;
  try {
    // Open a checked descriptor rather than opening the path later in the stream constructor.
    fd = fs.openSync(full, "r");
    const afterOpen = fs.fstatSync(fd);
    const finalPath = fs.realpathSync(full);
    if (!contained(selected.real, finalPath) || !afterOpen.isFile() || afterOpen.dev !== checked.dev || afterOpen.ino !== checked.ino) {
      throw httpError(403, "Файл изменился или вне разрешённой папки");
    }
    return { stream: fs.createReadStream(full, { fd, autoClose: true }), size: afterOpen.size, name: path.basename(finalPath) };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}
