// The launcher: programs from the Start menu and the desktop, and installed Steam games.
// The phone only ever gets ids; a launch looks the id up in this list, so nothing the phone sends
// is ever opened as a path or a command.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as cp from "node:child_process";
import * as pc from "./pc.js";

// shortcuts that are not something to start from a phone
const JUNK = /uninstall|удал|деинстал|readme|read me|help|справк|documentation|документац|manual|руководств|license|лиценз|release notes|website|веб-сайт|сайт|support|поддержк|changelog|what's new|repair|восстанов|safe mode|debug/i;
const JUNK_EXACT = /^(about .*|configure .*|check for updates|.*wizard|корзина|recycle bin|новости.*|параметры сбора данных|administrative tools|component services|computer management|event viewer|disk cleanup|dfrgui|character map|odbc.*|iscsi.*|memory diagnostics.*|performance monitor|print management|recoverydrive|registry editor|resource monitor|services|system configuration|system information|task scheduler|windows .*(firewall|defender|fax|media player legacy).*)$/i;
// Start menu folders of Windows' own tools
const JUNK_DIRS = /^(windows tools|administrative tools|system tools|accessibility|windows accessories|windows administrative tools|windows powershell|windows system|startup|автозагрузка|служебные.*|стандартные.*|специальные возможности|средства администрирования.*|maintenance)$/i;
const STEAM_TOOLS = /redistributable|steamworks|proton|steam linux runtime|steamvr|dedicated server/i;

const idOf = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3 && !JUNK_DIRS.test(e.name)) walk(p, depth + 1, out); }
    else if (/\.(lnk|url)$/i.test(e.name)) out.push(p);
  }
}

// a .url shortcut: only game launchers' links (steam://, com.epicgames.launcher://…), not web pages
function urlShortcut(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const url = (text.match(/^URL=(.+)$/m) || [])[1]?.trim() || "";
    if (!url || /^(https?|file):/i.test(url)) return null;
    const icon = (text.match(/^IconFile=(.+)$/m) || [])[1]?.trim() || "";
    return { url, icon };
  } catch {
    return null;
  }
}

function steamRoot() {
  return new Promise((resolve) => {
    cp.execFile("reg.exe", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { windowsHide: true, timeout: 5000 }, (err, out) => {
      const m = !err && String(out).match(/SteamPath\s+REG_SZ\s+(.+)/);
      resolve(m ? path.normalize(m[1].trim()) : "");
    });
  });
}

async function steamGames() {
  const root = await steamRoot();
  if (!root) return [];
  let libs = [path.join(root, "steamapps")];
  try {
    const vdf = fs.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
    libs = [...new Set([...libs, ...[...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => path.join(m[1].replace(/\\\\/g, "\\"), "steamapps"))])];
  } catch {}
  const games = [];
  for (const lib of libs) {
    let names = [];
    try { names = fs.readdirSync(lib).filter((n) => /^appmanifest_\d+\.acf$/.test(n)); } catch { continue; }
    for (const n of names) {
      try {
        const acf = fs.readFileSync(path.join(lib, n), "utf8");
        const appid = (acf.match(/"appid"\s+"(\d+)"/) || [])[1];
        const name = (acf.match(/"name"\s+"([^"]+)"/) || [])[1];
        const flags = Number((acf.match(/"StateFlags"\s+"(\d+)"/) || [])[1] || 0);
        if (!appid || !name || !(flags & 4) || STEAM_TOOLS.test(name)) continue; // installed games only
        // the wide header Steam shows in its library, from its own cache
        let art = "";
        const cache = path.join(root, "appcache", "librarycache", appid);
        try {
          for (const d of fs.readdirSync(cache, { withFileTypes: true })) {
            if (d.isDirectory() && fs.existsSync(path.join(cache, d.name, "library_header.jpg"))) { art = path.join(cache, d.name, "library_header.jpg"); break; }
          }
        } catch {}
        if (!art) {
          const old = path.join(root, "appcache", "librarycache", `${appid}_header.jpg`);
          if (fs.existsSync(old)) art = old;
        }
        games.push({ id: idOf("steam:" + appid), name, kind: "game", target: `steam://rungameid/${appid}`, art });
      } catch {}
    }
  }
  return games;
}

function programs() {
  const dirs = [
    path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(os.homedir(), "Desktop"),
    path.join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop")
  ];
  const files = [];
  for (const d of dirs) walk(d, 0, files);
  const out = [];
  for (const f of files) {
    const name = path.basename(f).replace(/\.(lnk|url)$/i, "").trim();
    if (!name || JUNK.test(name) || JUNK_EXACT.test(name)) continue;
    if (/\.url$/i.test(f)) {
      const u = urlShortcut(f);
      if (!u) continue;
      const steam = u.url.match(/^steam:\/\/rungameid\/(\d+)/i);
      out.push({ id: idOf(steam ? "steam:" + steam[1] : f), name, kind: steam || /launcher|games?/i.test(u.url) ? "game" : "app", target: f, iconFile: u.icon || "" });
    } else {
      out.push({ id: idOf(f), name, kind: "app", target: f, iconFile: f });
    }
  }
  return out;
}

// ── the list, kept for a while: a scan reads a few hundred small files ──────
let cached = null; // { at, items }
const icons = new Map(); // file → base64 PNG ("" = none)
const arts = new Map(); // file → base64 JPEG

async function scan() {
  if (cached && Date.now() - cached.at < 60000) return cached.items;
  const byId = new Map();
  for (const g of await steamGames()) byId.set(g.id, g);
  for (const p of programs()) {
    if (byId.has(p.id)) { // a Steam game's own shortcut: keep the library entry, take the shortcut's icon
      const g = byId.get(p.id);
      if (!g.iconFile && p.iconFile) g.iconFile = p.iconFile;
      continue;
    }
    // the same program in both Start menus or on the desktop too
    const twin = [...byId.values()].find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (!twin) byId.set(p.id, p);
  }
  const items = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  cached = { at: Date.now(), items };
  return items;
}

// [{ id, name, kind: "app" | "game", icon?: base64 PNG, art?: base64 JPEG }]
export async function list() {
  const items = await scan();
  const missing = [...new Set(items.map((x) => x.iconFile).filter((f) => f && !icons.has(f)))];
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    const got = await pc.icons(chunk).catch(() => []);
    chunk.forEach((f, k) => icons.set(f, got[k] || ""));
  }
  for (const g of items) {
    if (g.art && !arts.has(g.art)) arts.set(g.art, await pc.picture(g.art, 320).catch(() => ""));
  }
  return items.map((x) => ({
    id: x.id, name: x.name, kind: x.kind,
    ...(x.iconFile && icons.get(x.iconFile) ? { icon: icons.get(x.iconFile) } : {}),
    ...(x.art && arts.get(x.art) ? { art: arts.get(x.art) } : {})
  }));
}

export async function launch(id) {
  const item = (await scan()).find((x) => x.id === String(id));
  if (!item) throw Object.assign(new Error("Такой программы больше нет — обнови список"), { status: 404 });
  await pc.launch(item.target);
  return item.name;
}
