// What the phone can do to this PC by itself, without Astra: media keys, volume, a screenshot, power.
// A plugin's token is refused outside PluginHostService, so none of this can go through Astra's own
// MediaService — the plugin is a normal process running as the user and does it directly.
//
// The Windows work is one C# helper, compiled once into a DLL in the data folder and loaded by one
// long-lived PowerShell that runs requests one at a time: spawning a fresh PowerShell per volume step
// would cost a second of Add-Type every time.
import * as cp from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DATA_DIR } from "./store.js";

const HELPER = String.raw`
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr p, out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

public static class AR {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static AR() { SetProcessDPIAware(); }

  // media keys are extended keys: down, then up
  public static void MediaKey(int vk) { keybd_event((byte)vk, 0, 1, UIntPtr.Zero); keybd_event((byte)vk, 0, 3, UIntPtr.Zero); }
  public static void MonitorOff() { PostMessage((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2); }

  // the default output device is looked up every time: headphones may have been plugged in since
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
    var id = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v;
    Marshal.ThrowExceptionForHR(d.Activate(ref id, 23, IntPtr.Zero, out v));
    return v;
  }
  public static int GetVolume() { float f; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out f)); return (int)Math.Round(f * 100); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetVolume(int p) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, p)) / 100f, Guid.Empty)); }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }

  public static int Screens() { return Screen.AllScreens.Length; }
  // one monitor (index into AllScreens, the primary first) as a JPEG no wider than maxW
  public static string Shot(int index, int maxW, long quality) {
    var all = Screen.AllScreens;
    var s = Array.Find(all, x => x.Primary);
    if (index > 0 && index < all.Length) { var rest = Array.FindAll(all, x => !x.Primary); s = rest[index - 1]; }
    var b = s.Bounds;
    using (var full = new Bitmap(b.Width, b.Height)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size);
      double k = Math.Min(1.0, (double)maxW / b.Width);
      int w = Math.Max(1, (int)(b.Width * k)), h = Math.Max(1, (int)(b.Height * k));
      using (var small = new Bitmap(w, h)) {
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, w, h); }
        var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (var ms = new MemoryStream()) { small.Save(ms, codec, ps); return Convert.ToBase64String(ms.ToArray()); }
      }
    }
  }
}
`;

// The DLL is named after the hash of its source, so a new version of the plugin compiles its own.
// The source goes through a file: inline it would not fit on a PowerShell command line.
const HELPER_NAME = `helper-${crypto.createHash("sha256").update(HELPER).digest("hex").slice(0, 12)}`;
const DLL = path.join(DATA_DIR, HELPER_NAME + ".dll");
const SRC = path.join(DATA_DIR, HELPER_NAME + ".cs");

// Each request is one base64 line of script, each answer one line "OK <json>" or "ERR <text>".
const WORKER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$dll = '${DLL.replace(/'/g, "''")}'
if (-not (Test-Path $dll)) {
  $src = [IO.File]::ReadAllText('${SRC.replace(/'/g, "''")}', [Text.Encoding]::UTF8)
  $tmp = $dll + '.' + $PID + '.tmp'
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $src -OutputAssembly $tmp -OutputType Library
  try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}
Add-Type -Path $dll
function Media {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(3000); $t.Result }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  @{ title = $p.Title; artist = $p.Artist; app = $s.SourceAppUserModelId; playing = ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') }
}
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $r = Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)))
    [Console]::Out.WriteLine('OK ' + (ConvertTo-Json -InputObject $r -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\\s+', ' '))
  }
}
`;

let worker = null;
let ready = null;
let buffer = "";
const queue = [];

function startWorker() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DLL) && !fs.existsSync(SRC)) fs.writeFileSync(SRC, HELPER);
  const encoded = Buffer.from(WORKER, "utf16le").toString("base64");
  worker = cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let resolveReady, rejectReady;
  ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});
  let stderr = "";
  worker.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      if (line === "READY") { resolveReady(); continue; }
      const job = queue.shift();
      if (!job) continue;
      if (line.startsWith("OK ")) {
        try { job.resolve(JSON.parse(line.slice(3) || "null")); } catch { job.resolve(null); }
      } else job.reject(new Error(line.replace(/^ERR /, "")));
    }
  });
  worker.on("exit", () => {
    const err = new Error("PowerShell worker stopped" + (stderr ? ": " + stderr.trim() : ""));
    rejectReady(err);
    for (const job of queue.splice(0)) job.reject(err);
    worker = null;
    buffer = "";
  });
}

// Run one PowerShell snippet in the worker. Snippets are built here from fixed text and numbers only.
async function ps(script, timeoutMs = 15000) {
  if (!worker) startWorker();
  await ready;
  return new Promise((resolve, reject) => {
    const job = { resolve, reject };
    queue.push(job);
    const t = setTimeout(() => {
      // a stuck request would block every later one: restart the worker
      worker?.kill();
      reject(new Error("timed out"));
    }, timeoutMs);
    job.resolve = (v) => { clearTimeout(t); resolve(v); };
    job.reject = (e) => { clearTimeout(t); reject(e); };
    worker.stdin.write(Buffer.from(script, "utf8").toString("base64") + "\n");
  });
}

export function stopWorker() {
  worker?.kill();
  worker = null;
}

// Start the worker (and compile the helper) ahead of the first request.
export function warmUp() {
  return ps("1", 120000).catch(() => {});
}

const MEDIA_KEYS = { play_pause: 0xb3, next: 0xb0, prev: 0xb1, stop: 0xb2 };

export async function mediaKey(name) {
  if (!(name in MEDIA_KEYS)) throw new Error("unknown media key");
  await ps(`[AR]::MediaKey(${MEDIA_KEYS[name]})`);
}

export async function volume() {
  return ps("@{ volume = [AR]::GetVolume(); muted = [AR]::GetMute() }");
}

export async function setVolume({ volume: v, muted }) {
  if (v !== undefined) await ps(`[AR]::SetVolume(${Math.max(0, Math.min(100, Math.round(Number(v)) || 0))})`);
  if (muted !== undefined) await ps(`[AR]::SetMute($${muted ? "true" : "false"})`);
  return volume();
}

export async function nowPlaying() {
  return ps("Media", 8000).catch(() => null);
}

export async function screens() {
  return ps("[AR]::Screens()");
}

const int = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || d));

export async function screenshot(index = 0, maxWidth = 1600) {
  const b64 = await ps(`[AR]::Shot(${int(index, 0, 8, 0)}, ${int(maxWidth, 320, 3840, 1600)}, 72)`, 20000);
  return Buffer.from(String(b64), "base64");
}

function run(file, args) {
  return new Promise((resolve, reject) =>
    cp.execFile(file, args, { windowsHide: true, timeout: 15000 }, (err, _o, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve())));
}

export async function power(what) {
  switch (what) {
    case "lock": return run("rundll32.exe", ["user32.dll,LockWorkStation"]);
    case "monitor_off": return ps("[AR]::MonitorOff()");
    // the answer must reach the phone before the machine goes down
    case "sleep": setTimeout(() => ps("[System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)").catch(() => {}), 1500); return;
    case "shutdown": return run("shutdown.exe", ["/s", "/t", "60", "/c", "Astra Remote: выключение через минуту (отмена с телефона)"]);
    case "restart": return run("shutdown.exe", ["/r", "/t", "60", "/c", "Astra Remote: перезагрузка через минуту (отмена с телефона)"]);
    case "cancel": return run("shutdown.exe", ["/a"]);
    default: throw new Error("unknown power action");
  }
}

// ── clipboard and links ─────────────────────────────────────────────────────
// The worker runs -STA, which the Windows clipboard needs. Text from the phone travels as base64,
// so nothing the phone sends ever becomes PowerShell code.

export async function clipboard() {
  const text = await ps("if ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::GetText() } else { '' }");
  return String(text ?? "");
}

export async function setClipboard(text) {
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  await ps(`[System.Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`);
}

// Only web links: a file:// or ms-settings: link from the phone is not something to open blindly.
export function openUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error("Это не ссылка");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Открываются только ссылки http и https");
  return run("rundll32.exe", ["url.dll,FileProtocolHandler", u.href]);
}

// ── asking the owner at the PC ──────────────────────────────────────────────
// A Yes/No box on top of everything, "No" by default. Its own PowerShell, so the worker keeps serving
// the phone meanwhile. No answer within timeoutMs counts as "No".
export function confirmOnPc(text, timeoutMs = 60000) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AR_TEXT))
$f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$r = [System.Windows.Forms.MessageBox]::Show($f, $t, 'Astra Remote', 'YesNo', 'Warning', 'Button2')
if ($r -eq 'Yes') { exit 0 } else { exit 1 }`;
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const p = cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, AR_TEXT: Buffer.from(String(text), "utf8").toString("base64") } });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

// ── the TLS certificate ─────────────────────────────────────────────────────
// Made once, by Windows, and kept in the data folder. The app learns its SHA-256 from the QR code at
// pairing and from then on talks only to the PC holding this key, over an encrypted connection.
export async function ensureCertificate(pfxPath, passphrase) {
  if (fs.existsSync(pfxPath)) return;
  fs.mkdirSync(path.dirname(pfxPath), { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
$c = New-SelfSignedCertificate -Subject 'CN=Astra Remote' -KeyAlgorithm ECDSA_nistP256 -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(20) -KeyExportPolicy Exportable -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
try {
  $p = ConvertTo-SecureString -String '${passphrase}' -Force -AsPlainText
  Export-PfxCertificate -Cert $c -FilePath '${pfxPath.replace(/'/g, "''")}' -Password $p | Out-Null
} finally {
  Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint) -DeleteKey
}`;
  await new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    cp.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 60000 }, (err, _o, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve()));
  });
}

// ── system ──────────────────────────────────────────────────────────────────

// CPU load between two calls, from os.cpus() counters
let lastCpu = null;
function cpuLoad() {
  const now = os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total === prev.total) return null;
  return Math.round(100 * (1 - (now.idle - prev.idle) / (now.total - prev.total)));
}

export function system() {
  return {
    host: os.hostname(),
    uptimeMin: Math.round(os.uptime() / 60),
    cpu: cpuLoad(),
    ramUsed: Math.round(100 * (1 - os.freemem() / os.totalmem())),
    ramTotalGb: Math.round(os.totalmem() / 2 ** 30)
  };
}
