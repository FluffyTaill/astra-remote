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
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices.ComTypes;
using System.Globalization;
using System.Threading;
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

// the same two interfaces again, for Activate with any interface (here the session manager)
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceAny { [PreserveSig] int Activate(ref Guid id, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumeratorAny { [PreserveSig] int f(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDeviceAny d); }
// each app's own volume: one audio session per app on the default output device
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int s);
  [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int c(); [PreserveSig] int d(); [PreserveSig] int e();
  [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h(); [PreserveSig] int i(); [PreserveSig] int j();
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float v, ref Guid ctx); [PreserveSig] int GetMasterVolume(out float v);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}

// SendInput: the touchpad and the keyboard on the phone
[StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, data; public uint flags, time; public IntPtr extra; }
[StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
[StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
// the pointer, for drawing it into the live view (a screen copy leaves it out)
[StructLayout(LayoutKind.Sequential)] struct CPOINT { public int x, y; }
[StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public CPOINT pt; }
[StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }

public static class AR {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  // Real pixels on every monitor, each at its own scale (-4: per-monitor v2). Aware of the system scale
  // only, a second monitor at another scale (125% and 100%) was captured at the wrong size and place.
  static AR() {
    try {
      if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetThreadDpiAwarenessContext((IntPtr)(-4));
    } catch (EntryPointNotFoundException) {
      SetProcessDPIAware(); // Windows 10 before 1703
    }
  }

  // media keys are extended keys: down, then up
  public static void MediaKey(int vk) { keybd_event((byte)vk, 0, 1, UIntPtr.Zero); keybd_event((byte)vk, 0, 3, UIntPtr.Zero); }
  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no automatic sleep while the worker thread lives; the screen still turns off
  public static void KeepAwake(bool on) { SetThreadExecutionState(on ? 0x80000001u : 0x80000000u); }
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
  // monitors are numbered with the primary first, the rest in Windows' order
  static Screen ByIndex(int index) {
    var all = Screen.AllScreens;
    var rest = Array.FindAll(all, x => !x.Primary);
    return index > 0 && index <= rest.Length ? rest[index - 1] : Array.Find(all, x => x.Primary);
  }
  static int IndexOf(Screen s) {
    if (s.Primary) return 0;
    var rest = Array.FindAll(Screen.AllScreens, x => !x.Primary);
    return Array.FindIndex(rest, x => x.DeviceName == s.DeviceName) + 1;
  }

  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr h, out ICONINFO ii);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  static string F(double v) { return v.ToString("0.#####", CultureInfo.InvariantCulture); }

  // The live view under the touchpad: the monitor the pointer is on (index -1) or a given one, the
  // whole of it (zoom 1) or a part around the pointer (zoom 2..4), with the pointer drawn in and a
  // ring around it — drawn even while Windows hides the pointer, so it can always be found.
  // Answers JSON: the JPEG, which monitor, the part shown as fractions of it, the pointer in the image.
  public static string Live(int index, int maxW, long quality, int zoom) {
    var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    GetCursorInfo(ref ci);
    var s = index < 0 ? Screen.FromPoint(new Point(ci.pt.x, ci.pt.y)) : ByIndex(index);
    var b = s.Bounds;
    zoom = Math.Max(1, Math.Min(4, zoom));
    int cw = b.Width / zoom, ch = b.Height / zoom;
    int cx = zoom == 1 ? b.Left : Math.Max(b.Left, Math.Min(b.Right - cw, ci.pt.x - cw / 2));
    int cy = zoom == 1 ? b.Top : Math.Max(b.Top, Math.Min(b.Bottom - ch, ci.pt.y - ch / 2));
    double k = Math.Min(1.0, (double)maxW / cw);
    int px = ci.pt.x - cx, py = ci.pt.y - cy;
    string img;
    using (var full = new Bitmap(cw, ch)) {
      using (var g = Graphics.FromImage(full)) {
        g.CopyFromScreen(cx, cy, 0, 0, new Size(cw, ch));
        if ((ci.flags & 1) != 0 && ci.hCursor != IntPtr.Zero) {
          ICONINFO ii; int hx = 0, hy = 0;
          if (GetIconInfo(ci.hCursor, out ii)) {
            hx = ii.xHotspot; hy = ii.yHotspot;
            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
          }
          var hdc = g.GetHdc();
          try { DrawIconEx(hdc, px - hx, py - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(hdc); }
        }
        // sized to stay the same on the phone whatever the scale
        float r = (float)(20 / k), w = (float)(3.5 / k);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var dark = new Pen(Color.FromArgb(160, 0, 0, 0), w * 2)) g.DrawEllipse(dark, px - r, py - r, 2 * r, 2 * r);
        using (var pen = new Pen(Color.FromArgb(240, 243, 139, 168), w)) g.DrawEllipse(pen, px - r, py - r, 2 * r, 2 * r);
      }
      int w2 = Math.Max(1, (int)(cw * k)), h2 = Math.Max(1, (int)(ch * k));
      using (var small = new Bitmap(w2, h2)) {
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, w2, h2); }
        var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (var ms = new MemoryStream()) { small.Save(ms, codec, ps); img = Convert.ToBase64String(ms.ToArray()); }
      }
    }
    return "{\"img\":\"" + img + "\",\"screen\":" + IndexOf(s) + ",\"screens\":" + Screen.AllScreens.Length
      + ",\"rect\":[" + F((double)(cx - b.Left) / b.Width) + "," + F((double)(cy - b.Top) / b.Height) + "," + F((double)cw / b.Width) + "," + F((double)ch / b.Height) + "]"
      + ",\"cur\":[" + F((double)px / cw) + "," + F((double)py / ch) + "]}";
  }
  // the pointer to a point of a monitor, given as fractions of it (a tap on the live view)
  public static void Point(int index, double fx, double fy) {
    var b = ByIndex(index).Bounds;
    SetCursorPos(b.Left + (int)(Math.Max(0, Math.Min(1, fx)) * (b.Width - 1)), b.Top + (int)(Math.Max(0, Math.Min(1, fy)) * (b.Height - 1)));
  }
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

  // ── input ──
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static void Send(List<INPUT> a) { if (a.Count > 0) SendInput((uint)a.Count, a.ToArray(), Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(int data, uint flags, int dx = 0, int dy = 0) { var i = new INPUT { type = 0 }; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.data = data; i.u.mi.flags = flags; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  static readonly uint[] DOWN = { 0x2, 0x8, 0x20 }, UP = { 0x4, 0x10, 0x40 };
  public static void Move(int dx, int dy) { Send(new List<INPUT> { M(0, 0x1, dx, dy) }); }
  // button 0 left, 1 right, 2 middle; kind 0 click, 1 press, 2 release
  public static void Button(int b, int kind) {
    b = Math.Max(0, Math.Min(2, b));
    var a = new List<INPUT>();
    if (kind != 2) a.Add(M(0, DOWN[b]));
    if (kind != 1) a.Add(M(0, UP[b]));
    Send(a);
  }
  public static void Wheel(int v, int h) {
    var a = new List<INPUT>();
    if (v != 0) a.Add(M(v, 0x800));
    if (h != 0) a.Add(M(h, 0x1000));
    Send(a);
  }
  // text as Unicode key strokes, so any language goes in without switching the layout
  public static void Text(string s) {
    var a = new List<INPUT>();
    foreach (char c in s) {
      if (c == '\n') { a.Add(K(0x0D, 0, 0)); a.Add(K(0x0D, 0, 2)); }
      else if (c != '\r') { a.Add(K(0, c, 4)); a.Add(K(0, c, 6)); }
    }
    Send(a);
  }
  static uint Ext(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B ? 1u : 0u; }
  // one key with modifiers: 1 Ctrl, 2 Shift, 4 Alt, 8 Win
  public static void Key(int vk, int mods) {
    var mk = new List<int>();
    if ((mods & 1) != 0) mk.Add(0x11);
    if ((mods & 2) != 0) mk.Add(0x10);
    if ((mods & 4) != 0) mk.Add(0x12);
    if ((mods & 8) != 0) mk.Add(0x5B);
    var a = new List<INPUT>();
    foreach (var m in mk) a.Add(K((ushort)m, 0, Ext(m)));
    a.Add(K((ushort)vk, 0, Ext(vk))); a.Add(K((ushort)vk, 0, Ext(vk) | 2));
    for (int i = mk.Count - 1; i >= 0; i--) a.Add(K((ushort)mk[i], 0, Ext(mk[i]) | 2));
    Send(a);
  }

  // ── each app's volume ──
  static List<IAudioSessionControl2> Sessions() {
    var en = (IMMDeviceEnumeratorAny)new MMDeviceEnumerator(); IMMDeviceAny d;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out d));
    var iid = typeof(IAudioSessionManager2).GUID; object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    IAudioSessionEnumerator e; Marshal.ThrowExceptionForHR(((IAudioSessionManager2)o).GetSessionEnumerator(out e));
    int n; e.GetCount(out n);
    var all = new List<IAudioSessionControl2>();
    for (int i = 0; i < n; i++) { IAudioSessionControl2 s; if (e.GetSession(i, out s) == 0) all.Add(s); }
    return all;
  }
  static string Js(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < ' ') b.Append(' '); else b.Append(c); }
    return b.Append('"').ToString();
  }
  // [{pid, name, volume, muted}] of apps that have a sound session; pid 0 is Windows' own sounds
  public static string Apps() {
    var seen = new Dictionary<uint, bool>(); var b = new StringBuilder("[");
    foreach (var s in Sessions()) {
      int st; s.GetState(out st); if (st == 2) continue; // expired
      uint pid; s.GetProcessId(out pid);
      bool sys = s.IsSystemSoundsSession() == 0;
      if (sys) pid = 0;
      if (seen.ContainsKey(pid)) continue; seen[pid] = true;
      string name = sys ? "" : null;
      if (!sys) {
        try {
          var p = Process.GetProcessById((int)pid); name = p.ProcessName;
          try { var d = p.MainModule.FileVersionInfo.FileDescription; if (!string.IsNullOrWhiteSpace(d)) name = d.Trim(); } catch { }
        } catch { continue; } // the app is gone
      }
      var v = (ISimpleAudioVolume)s; float lv; bool m; v.GetMasterVolume(out lv); v.GetMute(out m);
      if (b.Length > 1) b.Append(',');
      b.Append("{\"pid\":").Append(pid).Append(",\"name\":").Append(Js(name)).Append(",\"volume\":").Append((int)Math.Round(lv * 100))
        .Append(",\"muted\":").Append(m ? "true" : "false").Append('}');
    }
    return b.Append(']').ToString();
  }
  // volume -1 and mute -1 leave that one as it is
  public static void SetApp(int pid, int volume, int mute) {
    Guid ctx = Guid.Empty; bool found = false;
    foreach (var s in Sessions()) {
      uint p; s.GetProcessId(out p);
      if (s.IsSystemSoundsSession() == 0) p = 0;
      if (p != (uint)pid) continue;
      found = true;
      var v = (ISimpleAudioVolume)s;
      if (volume >= 0) v.SetMasterVolume(Math.Min(100, volume) / 100f, ref ctx);
      if (mute >= 0) v.SetMute(mute == 1, ref ctx);
    }
    if (!found) throw new Exception("Это приложение больше не играет звук");
  }

  // ── pictures: the cover of what plays, app icons, game art ──
  [DllImport("shcore.dll")] static extern int CreateStreamOverRandomAccessStream([MarshalAs(UnmanagedType.IUnknown)] object ras, ref Guid riid, out IStream s);
  static string Jpeg(Image img, int max) {
    double k = Math.Min(1.0, (double)max / Math.Max(img.Width, img.Height));
    int w = Math.Max(1, (int)(img.Width * k)), h = Math.Max(1, (int)(img.Height * k));
    using (var small = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(img, 0, 0, w, h); }
      var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
      var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
      using (var ms = new MemoryStream()) { small.Save(ms, codec, ps); return Convert.ToBase64String(ms.ToArray()); }
    }
  }
  // a WinRT stream (the media session's thumbnail) as a JPEG no bigger than max
  public static string Cover(object ras, int max) {
    var iid = new Guid("0000000c-0000-0000-C000-000000000046"); IStream s;
    Marshal.ThrowExceptionForHR(CreateStreamOverRandomAccessStream(ras, ref iid, out s));
    var ms = new MemoryStream(); var buf = new byte[65536]; var got = Marshal.AllocHGlobal(4);
    try {
      while (ms.Length < 16 << 20) { s.Read(buf, buf.Length, got); int n = Marshal.ReadInt32(got); if (n <= 0) break; ms.Write(buf, 0, n); }
    } finally { Marshal.FreeHGlobal(got); }
    ms.Position = 0;
    using (var img = Image.FromStream(ms)) return Jpeg(img, max);
  }
  public static string Picture(string path, int max) { using (var img = Image.FromFile(path)) return Jpeg(img, max); }
  // each file's icon as a PNG ("" where there is none), one per line in and out
  public static string Icons(string paths) {
    var b = new StringBuilder();
    foreach (var p in paths.Split('\n')) {
      string r = "";
      try {
        using (var ic = Icon.ExtractAssociatedIcon(p)) using (var bmp = ic.ToBitmap()) using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); r = Convert.ToBase64String(ms.ToArray()); }
      } catch { }
      b.Append(r).Append('\n');
    }
    return b.ToString();
  }
}

// Recording what one process (and the processes it started) plays: Windows' process loopback
// (Windows 10 2004 and later). Runs on a thread of its own and keeps what it heard until it is read.
[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler { void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op); }
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation { void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }
[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClientX {
  [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
  [PreserveSig] int GetBufferSize(out uint n);
  [PreserveSig] int GetStreamLatency(out long l);
  [PreserveSig] int GetCurrentPadding(out uint p);
  [PreserveSig] int IsFormatSupported(int mode, IntPtr format, IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long def, out long min);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr h);
  [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClientX {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong pos, out ulong qpc);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

public class LoopbackDone : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  public readonly ManualResetEvent Done = new ManualResetEvent(false);
  public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { Done.Set(); }
}

public static class Voice {
  [DllImport("Mmdevapi.dll", ExactSpelling = true)]
  static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid, IntPtr prop,
    IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

  public const int RATE = 24000; // mono, 16 bit: plenty for a voice, 48 KB a second
  static Thread thread;
  static volatile bool running;
  static readonly object gate = new object();
  static MemoryStream heard = new MemoryStream();
  static string error = "";
  // The recording follows the app's volume on the PC (muted = silence). Turned down there so the
  // room does not hear her, it is turned up here by as much.
  static volatile float gain = 1;
  public static void Gain(double g) { gain = (float)Math.Max(1, Math.Min(40, g)); }

  public static void Start(int pid) {
    Stop();
    lock (gate) { heard.SetLength(0); error = ""; }
    gain = 1;
    running = true;
    thread = new Thread(() => Run(pid)) { IsBackground = true };
    thread.SetApartmentState(ApartmentState.MTA);
    thread.Start();
  }
  public static void Stop() {
    running = false;
    if (thread != null) thread.Join(2000);
    thread = null;
  }
  // what was heard since the last read: base64 PCM, its loudest sample (0..32767) and any error
  public static string Read() {
    byte[] b; string e;
    lock (gate) { b = heard.ToArray(); heard.SetLength(0); e = error; }
    int peak = 0;
    float k = gain;
    for (int i = 0; i + 1 < b.Length; i += 2) {
      int v = (short)(b[i] | (b[i + 1] << 8));
      if (k != 1) { v = (int)Math.Max(-32768, Math.Min(32767, v * k)); b[i] = (byte)v; b[i + 1] = (byte)(v >> 8); }
      if (Math.Abs(v) > peak) peak = Math.Abs(v);
    }
    return "{\"pcm\":\"" + Convert.ToBase64String(b) + "\",\"peak\":" + peak + ",\"error\":\"" + e.Replace("\\", "/").Replace("\"", "'") + "\"}";
  }

  static void Run(int pid) {
    IntPtr prop = IntPtr.Zero, args = IntPtr.Zero, fmt = IntPtr.Zero;
    try {
      // AUDIOCLIENT_ACTIVATION_PARAMS: process loopback (1) of this process and its children (mode 0)
      args = Marshal.AllocHGlobal(12);
      Marshal.WriteInt32(args, 0, 1);
      Marshal.WriteInt32(args, 4, pid);
      Marshal.WriteInt32(args, 8, 0);
      // a PROPVARIANT holding it as a BLOB (VT_BLOB = 65)
      prop = Marshal.AllocHGlobal(24);
      for (int i = 0; i < 24; i++) Marshal.WriteByte(prop, i, 0);
      Marshal.WriteInt16(prop, 0, 65);
      Marshal.WriteInt32(prop, 8, 12);
      Marshal.WriteIntPtr(prop, IntPtr.Size == 8 ? 16 : 12, args);
      var iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
      var done = new LoopbackDone();
      IActivateAudioInterfaceAsyncOperation op;
      Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, prop, done, out op));
      if (!done.Done.WaitOne(5000)) throw new Exception("activation timed out");
      int hr; object o;
      op.GetActivateResult(out hr, out o);
      Marshal.ThrowExceptionForHR(hr);
      var client = (IAudioClientX)o;
      // WAVEFORMATEX: PCM, mono, RATE, 16 bit
      fmt = Marshal.AllocHGlobal(18);
      Marshal.WriteInt16(fmt, 0, 1); Marshal.WriteInt16(fmt, 2, 1); Marshal.WriteInt32(fmt, 4, RATE);
      Marshal.WriteInt32(fmt, 8, RATE * 2); Marshal.WriteInt16(fmt, 12, 2); Marshal.WriteInt16(fmt, 14, 16); Marshal.WriteInt16(fmt, 16, 0);
      // loopback | event callback | convert to our format
      Marshal.ThrowExceptionForHR(client.Initialize(0, 0x00020000u | 0x00040000u | 0x80000000u | 0x08000000u, 2000000, 0, fmt, IntPtr.Zero));
      var ready = new AutoResetEvent(false);
      Marshal.ThrowExceptionForHR(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()));
      var cid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
      object co;
      Marshal.ThrowExceptionForHR(client.GetService(ref cid, out co));
      var capture = (IAudioCaptureClientX)co;
      Marshal.ThrowExceptionForHR(client.Start());
      var chunk = new byte[RATE * 2];
      while (running) {
        ready.WaitOne(100);
        uint next;
        while (capture.GetNextPacketSize(out next) == 0 && next > 0) {
          IntPtr data; uint frames, flags; ulong pos, qpc;
          if (capture.GetBuffer(out data, out frames, out flags, out pos, out qpc) != 0) break;
          int n = (int)frames * 2;
          if (chunk.Length < n) chunk = new byte[n];
          if ((flags & 2) != 0) Array.Clear(chunk, 0, n); else Marshal.Copy(data, chunk, 0, n);
          capture.ReleaseBuffer(frames);
          lock (gate) { if (heard.Length < 30 * RATE * 2) heard.Write(chunk, 0, n); }
        }
      }
      client.Stop();
      Marshal.ReleaseComObject(capture);
      Marshal.ReleaseComObject(client);
    } catch (Exception e) {
      lock (gate) error = e.Message;
    } finally {
      if (fmt != IntPtr.Zero) Marshal.FreeHGlobal(fmt);
      if (prop != IntPtr.Zero) Marshal.FreeHGlobal(prop);
      if (args != IntPtr.Zero) Marshal.FreeHGlobal(args);
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
# what plays: Windows' media session (the one in the volume flyout)
$script:asTask = $null
function Await($op, $type) {
  if (-not $script:asTask) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  }
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(3000); $t.Result
}
function Session {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $mgr.GetCurrentSession()
}
function Props($s) { Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) }
function Media {
  $s = Session
  if (-not $s) { return $null }
  $p = Props $s
  $i = $s.GetPlaybackInfo(); $t = $s.GetTimelineProperties()
  $playing = $i.PlaybackStatus -eq 'Playing'
  $dur = ($t.EndTime - $t.StartTime).TotalSeconds
  $pos = ($t.Position - $t.StartTime).TotalSeconds
  # players report the position now and then: count on from when they did
  if ($playing -and $t.LastUpdatedTime.Year -gt 2000) { $pos += ([DateTimeOffset]::Now - $t.LastUpdatedTime).TotalSeconds }
  @{ title = $p.Title; artist = $p.Artist; app = $s.SourceAppUserModelId; playing = $playing; cover = [bool]$p.Thumbnail
     dur = [math]::Round([math]::Max($dur, 0), 1); pos = [math]::Round([math]::Max([math]::Min($pos, $dur), 0), 1)
     seek = [bool]$i.Controls.IsPlaybackPositionEnabled -and $dur -gt 0 }
}
function Cover {
  $s = Session
  if (-not $s) { return $null }
  $p = Props $s
  if (-not $p.Thumbnail) { return $null }
  [AR]::Cover((Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])), 360)
}
function Seek($sec) {
  $s = Session
  if (-not $s) { throw 'Ничего не играет' }
  $t = $s.GetTimelineProperties()
  if (-not (Await ($s.TryChangePlaybackPositionAsync([long](($t.StartTime.TotalSeconds + $sec) * 10000000))) ([bool]))) { throw 'Этот плеер не даёт перематывать' }
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

// A worker: one PowerShell with the helper loaded, running snippets one at a time.
function makeWorker() {
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

  return { ps, stop() { worker?.kill(); worker = null; } };
}

// The main worker, one for the touchpad and one for its live view: a screenshot or a cover may take
// a moment, and the pointer must not wait behind them.
const main = makeWorker();
const pointer = makeWorker();
const viewer = makeWorker();
const listener = makeWorker(); // records Astra's voice for the phone (Voice in the helper keeps its own thread)
const ps = main.ps;

// the PowerShell workers go with the plugin, however it ends
process.on("exit", () => stopWorker());

export function stopWorker() {
  main.stop();
  pointer.stop();
  viewer.stop();
  listener.stop();
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

// The cover of what plays, as a JPEG in base64 (null when the player gives none).
export async function cover() {
  return ps("Cover", 10000);
}

export async function seek(sec) {
  await ps(`Seek ${Math.max(0, Math.min(360000, Number(sec) || 0)).toFixed(1)}`, 8000);
}

// Each app's own volume, as in Windows' volume mixer.
export async function appVolumes() {
  return JSON.parse(await ps("[AR]::Apps()"));
}

export async function setAppVolume({ pid, volume: v, muted }) {
  const id = Math.round(Number(pid));
  if (!Number.isFinite(id) || id < 0) throw new Error("bad pid");
  await ps(`[AR]::SetApp(${id}, ${v === undefined ? -1 : int(v, 0, 100, 0)}, ${muted === undefined ? -1 : muted ? 1 : 0})`);
  return appVolumes();
}

// ── the touchpad and the keyboard ───────────────────────────────────────────
// A batch of events from the phone, run in the pointer worker as one snippet. Every number is clamped
// here and text travels as base64, so nothing the phone sends ever becomes PowerShell code.
//   ["m", dx, dy]  move      ["b", button, kind]  click (0) / press (1) / release (2), button 0 left 1 right 2 middle
//   ["w", v, h]    wheel     ["t", text]          type   ["k", vk, mods]  a key, mods 1 Ctrl 2 Shift 4 Alt 8 Win
//   ["p", screen, x, y]  the pointer to x, y of a monitor, in ten-thousandths of it
export async function input(events) {
  const lines = [];
  for (const e of Array.isArray(events) ? events.slice(0, 200) : []) {
    if (!Array.isArray(e)) continue;
    switch (e[0]) {
      case "m": lines.push(`[AR]::Move(${int(e[1], -4000, 4000, 0)}, ${int(e[2], -4000, 4000, 0)})`); break;
      case "b": lines.push(`[AR]::Button(${int(e[1], 0, 2, 0)}, ${int(e[2], 0, 2, 0)})`); break;
      case "w": lines.push(`[AR]::Wheel(${int(e[1], -2400, 2400, 0)}, ${int(e[2], -2400, 2400, 0)})`); break;
      case "k": lines.push(`[AR]::Key(${int(e[1], 1, 254, 13)}, ${int(e[2], 0, 15, 0)})`); break;
      case "p": lines.push(`[AR]::Point(${int(e[1], 0, 8, 0)}, ${int(e[2], 0, 10000, 5000)} / 10000.0, ${int(e[3], 0, 10000, 5000)} / 10000.0)`); break;
      case "t": {
        const text = String(e[1] ?? "").slice(0, 2000);
        if (text) lines.push(`[AR]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}')))`);
        break;
      }
    }
  }
  // an empty batch starts the worker, so the first real touch does not wait for PowerShell
  await pointer.ps(lines.length ? lines.join("; ") + "; $null" : "1", lines.length ? 15000 : 120000);
}

// One frame of the touchpad's live view (see Live in the helper), as an object.
export async function liveFrame({ screen = -1, width = 960, zoom = 1, quality = 60 } = {}) {
  return JSON.parse(await viewer.ps(`[AR]::Live(${int(screen, -1, 8, -1)}, ${int(width, 320, 1920, 960)}, ${int(quality, 30, 90, 60)}, ${int(zoom, 1, 4, 1)})`, 15000));
}

// ── Astra's voice for the phone ─────────────────────────────────────────────
// What a process and the ones it started play, recorded as 24 kHz 16-bit mono PCM (Windows 10 2004+).
// The recording follows the process's volume on the PC: muted there is silent here, quieter is quieter.
export const VOICE_RATE = 24000;
export async function voiceStart(pid) {
  await listener.ps(`[Voice]::Start(${int(pid, 1, 1 << 30, 1)})`, 120000);
}
// { pcm: base64, peak: 0..32767, error }
export async function voiceRead() {
  return JSON.parse(await listener.ps("[Voice]::Read()", 10000));
}
export async function voiceGain(g) {
  await listener.ps(`[Voice]::Gain(${Math.max(1, Math.min(40, Number(g) || 1)).toFixed(3)})`, 10000);
}
export async function voiceStop() {
  await listener.ps("[Voice]::Stop()", 10000).catch(() => {});
}

// Pictures from files (Steam's game art) and icons of shortcuts, through the main worker.
export async function picture(file, max) {
  return ps(`[AR]::Picture([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(file), "utf8").toString("base64")}')), ${int(max, 16, 1024, 256)})`);
}
export async function icons(files) {
  if (!files.length) return [];
  const list = Buffer.from(files.join("\n"), "utf8").toString("base64");
  const out = String(await ps(`[AR]::Icons([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${list}')))`, 60000));
  return out.split("\n").slice(0, files.length);
}

// Something from the launcher (src/apps.js): a shortcut file or a steam:// link, opened the way
// Explorer would open it.
export function launch(target) {
  return run("rundll32.exe", ["url.dll,FileProtocolHandler", String(target)]);
}

// Keep the PC from sleeping on its own (so the phone can reach it from work). Held by the worker's
// thread, so it ends with the plugin; re-applied periodically in case the worker was restarted.
export async function keepAwake(on) {
  await ps(`[AR]::KeepAwake($${on ? "true" : "false"})`);
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
    case "shutdown": return run("shutdown.exe", ["/s", "/t", "60", "/c", "Phone Remote: выключение через минуту (отмена с телефона)"]);
    case "restart": return run("shutdown.exe", ["/r", "/t", "60", "/c", "Phone Remote: перезагрузка через минуту (отмена с телефона)"]);
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
$r = [System.Windows.Forms.MessageBox]::Show($f, $t, 'Phone Remote', 'YesNo', 'Warning', 'Button2')
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

// ── more numbers for the phone: the video card and the disks ────────────────
// Kept fresh in the background and read from memory, so /api/state never waits on nvidia-smi.
let extra = { gpu: null, disks: [] }, extraAt = 0;
function refreshExtra() {
  extraAt = Date.now();
  cp.execFile("nvidia-smi", ["--query-gpu=name,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 5000, windowsHide: true },
    (err, out) => {
      const m = !err && String(out).split(/\r?\n/)[0].split(",").map((x) => x.trim());
      extra.gpu = m && m.length >= 3 ? { name: m[0].replace(/^NVIDIA\s+/i, ""), temp: Number(m[1]), load: Number(m[2]) } : null;
    });
  const disks = [];
  for (const letter of "CDEFGHIJ") {
    try {
      const s = fs.statfsSync(letter + ":\\");
      const total = s.blocks * s.bsize;
      if (total > 0) disks.push({ name: letter + ":", freeGb: Math.round((s.bavail * s.bsize) / 2 ** 30), totalGb: Math.round(total / 2 ** 30) });
    } catch {}
  }
  extra.disks = disks;
}
export function moreStats() {
  if (Date.now() - extraAt > 15000) refreshExtra();
  return { gpu: extra.gpu, disks: extra.disks };
}

// A folder opened in Explorer on this PC's screen (the shared folder, from the plugin page or the phone).
export function openFolder(dir) {
  cp.spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
