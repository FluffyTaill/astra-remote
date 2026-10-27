// Builds the phone app without Gradle: aapt2 → javac → d8 → zip → zipalign → apksigner.
// Run: node android/build.js   →   android/astra-remote.apk
// Needs the Android SDK (build-tools, platforms;android-35) and a JDK 17+. The signing key is made on the
// first run (android/release.keystore + keystore.properties) — keep both: an update must be signed by
// the same key, or Android refuses to install it over the old app.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const root = __dirname;

// The avatar's three.js + three-vrm bundle (web/avatar.js → assets/avatar.js), when the plugin's
// node_modules are there; a copy of this folder elsewhere builds with the bundle it already has.
const esbuildPath = path.join(root, "..", "node_modules", "esbuild");
if (fs.existsSync(esbuildPath)) {
  require(esbuildPath).buildSync({
    entryPoints: [path.join(root, "web", "avatar.js")], bundle: true, minify: true, format: "iife", target: "es2020",
    legalComments: "eof", outfile: path.join(root, "assets", "avatar.js"), logLevel: "warning"
  });
}

// aapt2 cannot open a path with letters outside ASCII ("Astra — модели и плагины"): build in a copy
// under the temp folder, then bring the APK back.
if (/[^\x20-\x7e]/.test(root) && !process.env.AR_BUILD_COPY) {
  const tmp = path.join(require("node:os").tmpdir(), "astra-remote-android");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(root, tmp, { recursive: true, filter: (src) => !/[\\/]build$|\.apk$|\.idsig$/.test(src) });
  const r = cp.spawnSync(process.execPath, [path.join(tmp, "build.js")], { stdio: "inherit", env: { ...process.env, AR_BUILD_COPY: "1" } });
  if (r.status !== 0) process.exit(r.status || 1);
  fs.copyFileSync(path.join(tmp, "astra-remote.apk"), path.join(root, "astra-remote.apk"));
  // the signing key is made on a first build: keep it with the sources
  for (const f of ["release.keystore", "keystore.properties"]) {
    if (!fs.existsSync(path.join(root, f)) && fs.existsSync(path.join(tmp, f))) fs.copyFileSync(path.join(tmp, f), path.join(root, f));
  }
  console.log("built", path.join(root, "astra-remote.apk"));
  process.exit(0);
}

const out = path.join(root, "build");
const exe = (p) => (process.platform === "win32" && !/\.(exe|bat)$/.test(p) && fs.existsSync(p + ".exe") ? p + ".exe" : fs.existsSync(p + ".bat") ? p + ".bat" : p);

function sdkDir() {
  const c = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk")];
  const d = c.find((x) => x && fs.existsSync(path.join(x, "build-tools")));
  if (!d) throw new Error("Android SDK not found: set ANDROID_HOME");
  return d;
}
function jdkBin() {
  const c = [process.env.JAVA_HOME];
  for (const base of ["C:\\Program Files\\Microsoft", "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Java", "C:\\Program Files\\Android\\Android Studio"]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort().reverse()) c.push(path.join(base, d), path.join(base, d, "jbr"));
  }
  const d = c.find((x) => x && fs.existsSync(exe(path.join(x, "bin", "javac"))));
  if (!d) throw new Error("JDK 17+ not found: set JAVA_HOME");
  return path.join(d, "bin");
}

const sdk = sdkDir();
const bt = path.join(sdk, "build-tools", fs.readdirSync(path.join(sdk, "build-tools")).sort().pop());
const platform = path.join(sdk, "platforms", "android-35", "android.jar");
const jdk = jdkBin();
const tool = (name) => exe(path.join(bt, name));
const libs = fs.existsSync(path.join(root, "libs")) ? fs.readdirSync(path.join(root, "libs")).filter((f) => f.endsWith(".jar")).map((f) => path.join(root, "libs", f)) : [];

function run(file, args, opts = {}) {
  // .bat tools (d8, apksigner) need a shell on Windows; arguments are our own paths, quoted
  const shell = /\.bat$/i.test(file);
  const q = (a) => (shell && /[\s&()]/.test(a) ? `"${a}"` : a);
  const r = cp.spawnSync(shell ? `"${file}"` : file, shell ? args.map(q) : args, { stdio: "inherit", shell, ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(file)} failed (${r.status ?? r.error?.message})`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "classes"), { recursive: true });
fs.mkdirSync(path.join(out, "dex"), { recursive: true });
fs.mkdirSync(path.join(out, "apk"), { recursive: true });

// 1. resources and manifest
run(tool("aapt2"), ["compile", "--dir", path.join(root, "res"), "-o", path.join(out, "res.zip")]);
run(tool("aapt2"), ["link", "-I", platform, "--manifest", path.join(root, "AndroidManifest.xml"), "-A", path.join(root, "assets"),
  "--min-sdk-version", "26", "--target-sdk-version", "35", "--java", path.join(out, "gen"), // R.java: the widget's layout, the tiles' icons
  "-o", path.join(out, "base.apk"), path.join(out, "res.zip")]);
// unpacked, so the final zip can be written with resources.arsc stored (aapt2's --output-to-dir trips on Windows)
run(exe(path.join(jdk, "jar")), ["xf", path.join(out, "base.apk")], { cwd: path.join(out, "apk") });

// 2. Java → classes → dex
const sources = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".java")) sources.push(p);
  }
})(path.join(root, "src"));
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".java")) sources.push(p);
  }
})(path.join(out, "gen"));
run(exe(path.join(jdk, "javac")), ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-Xlint:-options", "-nowarn",
  "-bootclasspath", platform + path.delimiter + path.join(bt, "core-lambda-stubs.jar"), "-classpath", libs.join(path.delimiter), "-d", path.join(out, "classes"), ...sources]);
const classes = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".class")) classes.push(p);
  }
})(path.join(out, "classes"));
run(tool("d8"), ["--release", "--min-api", "26", "--lib", platform, "--output", path.join(out, "dex"), ...classes, ...libs],
  { env: { ...process.env, JAVA_HOME: path.dirname(jdk), PATH: jdk + path.delimiter + process.env.PATH } });
fs.copyFileSync(path.join(out, "dex", "classes.dex"), path.join(out, "apk", "classes.dex"));

// 3. zip; resources.arsc must be stored uncompressed (Android 11+ refuses to install otherwise)
const entries = [];
(function walk(d, rel) {
  for (const f of fs.readdirSync(d).sort()) {
    const p = path.join(d, f), r = rel ? rel + "/" + f : f;
    if (fs.statSync(p).isDirectory()) walk(p, r);
    else entries.push([r, fs.readFileSync(p)]);
  }
})(path.join(out, "apk"), "");
entries.sort((a, b) => (a[0] === "AndroidManifest.xml" ? -1 : b[0] === "AndroidManifest.xml" ? 1 : 0));
const local = [], central = [];
let offset = 0;
const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
for (const [name, data] of entries) {
  const deflate = !/^resources\.arsc$|\.(png|jpg|webp|ogg|mp3)$/.test(name);
  const body = deflate ? zlib.deflateRawSync(data, { level: 9 }) : data;
  const crc = zlib.crc32(data);
  const nameBuf = Buffer.from(name, "utf8");
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(deflate ? 8 : 0, 8);
  h.writeUInt16LE(0, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26);
  local.push(h, nameBuf, body);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + body.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.writeFileSync(path.join(out, "unsigned.apk"), Buffer.concat([...local, cd, end]));

// 4. align and sign
run(tool("zipalign"), ["-p", "-f", "4", path.join(out, "unsigned.apk"), path.join(out, "aligned.apk")]);
const ks = path.join(root, "release.keystore");
const props = path.join(root, "keystore.properties");
if (!fs.existsSync(ks)) {
  const pass = crypto.randomBytes(18).toString("base64url");
  run(exe(path.join(jdk, "keytool")), ["-genkeypair", "-keystore", ks, "-storetype", "PKCS12", "-alias", "astra-remote", "-keyalg", "EC", "-groupname", "secp256r1",
    "-validity", "10000", "-dname", "CN=Astra Remote", "-storepass", pass, "-keypass", pass]);
  fs.writeFileSync(props, `password=${pass}\n`);
}
const pass = fs.readFileSync(props, "utf8").match(/^password=(.*)$/m)[1].trim();
const apk = path.join(root, "astra-remote.apk");
run(tool("apksigner"), ["sign", "--ks", ks, "--ks-key-alias", "astra-remote", "--ks-pass", "env:AR_KS_PASS", "--out", apk, path.join(out, "aligned.apk")],
  { env: { ...process.env, AR_KS_PASS: pass, JAVA_HOME: path.dirname(jdk), PATH: jdk + path.delimiter + process.env.PATH } });
run(tool("apksigner"), ["verify", apk], { env: { ...process.env, JAVA_HOME: path.dirname(jdk), PATH: jdk + path.delimiter + process.env.PATH } });
console.log(`built ${path.relative(process.cwd(), apk)} (${Math.round(fs.statSync(apk).size / 1024)} KB)`);
