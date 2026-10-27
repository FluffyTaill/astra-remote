// Builds dist/index.js, MANIFEST.json and the .astraplugin. Run: node build.js
// The bundle is one file with everything inside (the catalogue rejects one that loads modules at run
// time); the phone app is bundled into it as text. The .astraplugin is a zip whose MANIFEST.json is
// stored, not compressed, and every file is 0644.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const esbuild = require("esbuild");

const root = __dirname;
const toml = fs.readFileSync(path.join(root, "plugin.toml"), "utf8");
const field = (name) => toml.match(new RegExp("^" + name + String.raw`\s*=\s*"([^"]*)"`, "m"))[1];
const id = field("id"), version = field("version");

// ws tries the native speedups bufferutil and utf-8-validate inside try/catch. Point them at a module that
// throws on load, so ws takes its JS fallback and dist/index.js resolves nothing at run time.
const optionalNative = path.join(root, "src/optional-native.js");

esbuild.buildSync({
  entryPoints: [path.join(root, "src/index.ts")], bundle: true, platform: "node", format: "cjs", target: "node20",
  outfile: path.join(root, "dist/index.js"), loader: { ".html": "text", ".svg": "text" }, legalComments: "eof", logLevel: "warning",
  alias: { bufferutil: optionalNative, "utf-8-validate": optionalNative }
});

// [permissions] → { name: { reason } }; the hash is sha256 of compact JSON with sorted keys
const permissions = {};
const permBlock = toml.split(/^\[permissions\]\s*$/m)[1].split(/^\[/m)[0];
for (const m of permBlock.matchAll(/^(\w+)\s*=\s*\{\s*reason\s*=\s*"([^"]*)"\s*\}/gm)) permissions[m[1]] = { reason: m[2] };
const capBlock = toml.split(/^\[capabilities\]\s*$/m)[1].split(/^\[/m)[0];
const capabilities = [...capBlock.matchAll(/^(\w+)\s*=\s*true/gm)].map((m) => m[1]);
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",")}}`
  : JSON.stringify(v);

// Astra wants MANIFEST.files sorted byte-wise by path
const fileList = ["LICENSE", "README.md", "dist/index.js", "icon.svg", "plugin.toml", "ui/index.html", "ui/app.js"]
  .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const read = (p) => fs.readFileSync(path.join(root, p));
const files = fileList.map((p) => ({ path: p, sha256: crypto.createHash("sha256").update(read(p)).digest("hex"), size: read(p).length, mode: "0644" }));
const manifest = {
  schema: "astra.bundle/2", plugin_id: id, version, platform: { os: "windows", arch: "any" }, protocol: 1, min_astra_version: "",
  capabilities, permissions, permissions_hash: "sha256:" + crypto.createHash("sha256").update(canonical(permissions)).digest("hex"),
  entry: { command: "node", args: ["dist/index.js"] }, files
};
const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(root, "MANIFEST.json"), manifestJson);

// ── a minimal zip writer ──
const entries = [["MANIFEST.json", manifestJson, false], ...fileList.map((p) => [p, read(p), true])];
const local = [], central = [];
let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
for (const [name, data, deflate] of entries) {
  const body = deflate ? zlib.deflateRawSync(data, { level: 9 }) : data;
  const crc = zlib.crc32(data);
  const nameBuf = Buffer.from(name, "utf8");
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(deflate ? 8 : 0, 8);
  h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26);
  local.push(h, nameBuf, body);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
  c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + body.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const out = path.join(root, `${id}.astraplugin`);
fs.writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(`built ${path.basename(out)} ${version}:`, files.map((f) => `${f.path} ${f.size}`).join(", "));
