package tech.taill.astraremote;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;

/**
 * What the app's page (assets/index.html) may ask of the phone. The page never touches the network:
 * every request goes through here, over {@link Pinned}, with the key from {@link Vault}.
 * Answers go back to the page as calls to window.__native / __chat / __pair / __files / __shared.
 */
final class Bridge {
    private static final Pattern IPV4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");

    private final MainActivity activity;
    private final WebView web;
    private final Vault vault;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    // files go one at a time, in the order they were asked for
    private final ExecutorService transfers = Executors.newSingleThreadExecutor();
    private volatile Vault.Pairing pairing;
    private volatile Pinned net;
    private volatile TunaTunnel tuna; // the way in from anywhere, if the PC has a tuna
    private volatile InputChannel inputChannel;
    private volatile String inputId = "";
    private volatile boolean shuttingDown;
    private volatile boolean inputPaused;
    private volatile PairAttempt attempt;
    private volatile HttpsURLConnection chatConn;
    private volatile boolean chatStopped;
    private volatile boolean pageReady;
    private String pairName = "";
    private final List<Runnable> afterReady = new ArrayList<>();

    private static final class PairAttempt {
        volatile boolean cancelled;
    }

    Bridge(MainActivity activity, WebView web, Vault vault) {
        this.activity = activity;
        this.web = web;
        this.vault = vault;
        setPairing(vault.load());
        Remote.scheduleNotes(activity);
    }

    private void setPairing(Vault.Pairing p) {
        stopInputChannel();
        pairing = p;
        tuna = tunaFor(p);
        net = p == null ? null : new Pinned(p.hosts, p.port, p.fingerprint, p.lastHost, tuna);
    }

    /** The tuna this pairing names, reusing the running one when it is the same. */
    private TunaTunnel tunaFor(Vault.Pairing p) {
        TunaTunnel old = tuna;
        if (p != null && TunaTunnel.valid(p.tunaUrl, p.tunaKey)) {
            if (old != null && old.same(p.tunaUrl, p.tunaKey)) return old;
            if (old != null) old.close();
            return new TunaTunnel(p.tunaUrl, p.tunaKey);
        }
        if (old != null) old.close();
        return null;
    }

    void shutdown() {
        shuttingDown = true;
        stopInputChannel();
        if (tts != null) tts.shutdown();
        TunaTunnel r = tuna;
        if (r != null) r.close();
        PairAttempt a = attempt;
        if (a != null) a.cancelled = true;
        stopChat();
        pool.shutdownNow();
        transfers.shutdownNow();
    }

    private void js(final String script) {
        ui.post(() -> web.evaluateJavascript(script, null));
    }

    private static String q(String s) {
        return JSONObject.quote(s == null ? "" : s);
    }

    private void event(String fn, JSONObject o) {
        js("window." + fn + "&&window." + fn + "(" + o + ")");
    }

    // remember which address answered, so the next start tries it first
    private void rememberHost() {
        Vault.Pairing p = pairing;
        Pinned n = net;
        if (p == null || n == null || n.currentHost().equals(p.lastHost)) return;
        p.lastHost = n.currentHost();
        try {
            vault.save(p);
        } catch (Exception ignored) {
        }
    }

    private static List<String> validHosts(Iterable<String> list) {
        return Endpoint.valid(list);
    }

    /** Routes come only from the authenticated PC over the pinned connection. */
    private synchronized void updateHosts(String stateJson) {
        Vault.Pairing p = pairing;
        if (p == null) return;
        try {
            JSONObject st = new JSONObject(stateJson);
            JSONObject r = st.optJSONObject("tuna");
            String url = r == null ? "" : r.optString("url"), key = r == null ? "" : r.optString("key");
            if (r == null || r.optInt("v") != 1 || !TunaTunnel.valid(url, key)) url = key = "";
            org.json.JSONArray arr = st.optJSONArray("endpoints");
            if (arr == null) return;
            List<String> fresh = new ArrayList<>();
            for (int i = 0; i < Math.min(arr.length(), 16); i++) fresh.add(arr.optString(i));
            fresh = validHosts(fresh);
            if (fresh.equals(java.util.Arrays.asList(p.hosts)) && url.equals(p.tunaUrl) && key.equals(p.tunaKey)) return;
            String current = net == null ? p.lastHost : net.currentHost();
            p.hosts = fresh.toArray(new String[0]); p.tunaUrl = url; p.tunaKey = key;
            p.lastHost = fresh.contains(current) || TunaTunnel.HOST.equals(current) && !url.isEmpty() ? current : "";
            vault.save(p); setPairing(p);
        } catch (Exception ignored) {}
    }

    /** What the app does with each fresh /api/state besides the page: the widget's labels, Astra's notes. */
    private void afterState(String stateJson) {
        try {
            JSONObject st = new JSONObject(stateJson);
            org.json.JSONArray b = st.optJSONArray("buttons");
            if (b != null) ButtonsWidget.saveButtons(activity, b);
            long newest = st.optLong("notes");
            if (Remote.notesOn(activity) && newest > Remote.prefs(activity).getLong("lastNote", -1)) {
                pool.execute(() -> {
                    try {
                        Remote.checkNotes(activity);
                    } catch (Exception ignored) {
                    }
                });
            }
        } catch (Exception ignored) {
        }
    }

    // ── small things ────────────────────────────────────────────────────────

    @JavascriptInterface
    public boolean screenshotsAllowed() {
        return activity.screenshotsAllowed();
    }

    @JavascriptInterface
    public void setScreenshotsAllowed(final boolean on) {
        ui.post(() -> activity.setScreenshotsAllowed(on));
    }

    @JavascriptInterface
    public void openPhoneFolder() {
        ui.post(activity::openPhoneFolder);
    }

    // ── notes from Astra ────────────────────────────────────────────────────

    @JavascriptInterface
    public boolean notesEnabled() {
        return Remote.notesOn(activity);
    }

    @JavascriptInterface
    public void setNotes(final boolean on) {
        Remote.prefs(activity).edit().putBoolean("notes", on).apply();
        ui.post(() -> {
            if (on) activity.askNotifications();
            Remote.scheduleNotes(activity);
        });
    }

    /** The PC no longer knows this phone (unpaired there, or the key ran out): drop the pairing here too. */
    private void forgetLocally() {
        vault.clear();
        setPairing(null);
        deleteTree(avatarDir()); // the model belongs to that PC's owner: it does not outlive the pairing
        Remote.prefs(activity).edit().remove("lastNote").remove("widget").apply();
        Remote.scheduleNotes(activity); // no pairing: the job is cancelled
        ButtonsWidget.redraw(activity);
        js("window.__forgotten&&window.__forgotten()");
    }

    static String message(Exception e) {
        if (e instanceof ConnectException || e instanceof SocketTimeoutException || e instanceof NoRouteToHostException) {
            return "ПК недоступен. Проверь питание и запуск Astra. Вне дома также должен работать HTTP-туннель TUNA Desktop и адаптер TUNA в плагине. Дома приложение работает без TUNA";
        }
        String m = e.getMessage();
        if (m != null && m.contains(Pinned.MISMATCH)) return Pinned.MISMATCH;
        if (m != null && m.contains(TunaTunnel.OFFLINE)) return TunaTunnel.OFFLINE;
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    private static String errorJson(Exception e) {
        return "{\"error\":" + q(message(e)) + "}";
    }

    private static String errorOf(Pinned.Response r) {
        try {
            return new JSONObject(r.text()).optString("error", "Ошибка " + r.status);
        } catch (Exception e) {
            return "Ошибка " + r.status;
        }
    }

    // ── page lifecycle ──────────────────────────────────────────────────────

    /** The page has loaded; whatever was shared before that is handed over now. */
    @JavascriptInterface
    public void ready() {
        ui.post(() -> {
            pageReady = true;
            for (Runnable r : afterReady) r.run();
            afterReady.clear();
        });
    }

    private void whenReady(Runnable r) {
        ui.post(() -> {
            if (pageReady) r.run();
            else afterReady.add(r);
        });
    }

    // ── state ───────────────────────────────────────────────────────────────

    @JavascriptInterface
    public String status() {
        Vault.Pairing p = pairing;
        try {
            JSONObject o = new JSONObject();
            o.put("paired", p != null);
            o.put("pc", p == null ? "" : p.pcName);
            o.put("device", deviceName());
            o.put("lock", activity.lockEnabled());
            o.put("lockAvailable", activity.lockAvailable());
            o.put("via", net != null && TunaTunnel.HOST.equals(net.currentHost()) ? "TUNA" : "Домашняя сеть");
            o.put("tuna", p != null && TunaTunnel.valid(p.tunaUrl, p.tunaKey));
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public String setTunaAddress(String address) {
        try {
            Vault.Pairing p = pairing;
            String url = Endpoint.tuna(address);
            if (p == null || !TunaTunnel.valid(url, p.tunaKey)) throw new IllegalArgumentException("Нужна HTTPS-ссылка TUNA и ранее полученные с ПК настройки туннеля. Открой приложение дома или подключись по новому QR-коду");
            p.tunaUrl = url; p.lastHost = TunaTunnel.HOST;
            vault.save(p); setPairing(p);
            return "{}";
        } catch (Exception e) { return errorJson(e); }
    }

    @JavascriptInterface
    public String deviceName() {
        String m = Build.MODEL == null ? "" : Build.MODEL;
        String b = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String name = m.toLowerCase().startsWith(b.toLowerCase()) ? m : (b + " " + m).trim();
        return name.isEmpty() ? "Телефон" : name;
    }

    @JavascriptInterface
    public void vibrate() {
        Vibrator v = activity.getSystemService(Vibrator.class);
        if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE));
    }

    @JavascriptInterface
    public void setLock(boolean on) {
        ui.post(() -> activity.setLockEnabled(on));
    }

    // ── persistent touchpad channel ──────────────────────────────────────────
    private synchronized void stopInputChannel() {
        inputId = "";
        InputChannel channel = inputChannel; inputChannel = null;
        if (channel != null) channel.close();
    }

    void pauseInput() {
        inputPaused = true;
        stopInputChannel();
        js("window.__padPause&&window.__padPause()");
    }

    void resumeInput() {
        inputPaused = false;
        if (!shuttingDown) js("window.__padResume&&window.__padResume()");
    }

    @JavascriptInterface
    public synchronized void inputStart(final String id) {
        if (shuttingDown || inputPaused || id == null || id.length() > 80) return;
        stopInputChannel();
        final Pinned n = net; final Vault.Pairing p = pairing;
        if (n == null || p == null) return;
        inputId = id;
        inputChannel = new InputChannel(n, p.token, new InputChannel.Listener() {
            @Override public void message(String json) {
                if (id.equals(inputId)) js("window.__inputChannel&&window.__inputChannel(" + q(id) + "," + q(json) + ")");
            }
            @Override public void ended(String error) {
                if (id.equals(inputId)) js("window.__inputChannel&&window.__inputChannel(" + q(id) + "," + q("{\"error\":" + q(error) + "}") + ")");
            }
        });
        inputChannel.start();
    }

    @JavascriptInterface
    public boolean inputSend(String id, String json) {
        InputChannel channel = inputChannel;
        return id != null && id.equals(inputId) && channel != null && channel.send(json);
    }

    @JavascriptInterface
    public synchronized void inputStop(String id) {
        if (id != null && id.equals(inputId)) stopInputChannel();
    }

    // ── requests ────────────────────────────────────────────────────────────

    /** An API call; the answer comes back as __native(id, status, bodyText). Status 0 = no connection. */
    @JavascriptInterface
    public void call(final String id, final String method, final String path, final String body) {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        if (n == null || p == null || path == null || !path.startsWith("/api/") || path.startsWith("/api/pair")
                || !("GET".equals(method) || "POST".equals(method))) {
            js("window.__native(" + q(id) + ",401," + q("{\"error\":\"not paired\"}") + ")");
            return;
        }
        pool.execute(() -> {
            try {
                // a shutdown waits for "Allow" on the PC, up to a minute and a half
                Pinned.Response r = n.request(method, path, p.token, body == null || body.isEmpty() ? null : body, 100000);
                rememberHost();
                if (r.status == 401) forgetLocally();
                if (r.status == 200 && path.equals("/api/state")) {
                    updateHosts(r.text());
                    afterState(r.text());
                }
                js("window.__native(" + q(id) + "," + r.status + "," + q(r.text()) + ")");
            } catch (Exception e) {
                js("window.__native(" + q(id) + ",0," + q(errorJson(e)) + ")");
            }
        });
    }

    /** A screenshot; the answer is __native(id, status, base64 JPEG or error JSON). */
    @JavascriptInterface
    public void screenshot(final String id, final int screen, final int width) {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        if (n == null || p == null) {
            js("window.__native(" + q(id) + ",401,\"\")");
            return;
        }
        final String path = "/api/screenshot?screen=" + Math.max(0, Math.min(8, screen)) + "&w=" + Math.max(320, Math.min(2400, width));
        pool.execute(() -> {
            try {
                Pinned.Response r = n.request("GET", path, p.token, null);
                rememberHost();
                if (r.status == 401) forgetLocally();
                String text = r.status == 200 ? Base64.encodeToString(r.body, Base64.NO_WRAP) : r.text();
                js("window.__native(" + q(id) + "," + r.status + "," + q(text) + ")");
            } catch (Exception e) {
                js("window.__native(" + q(id) + ",0," + q(errorJson(e)) + ")");
            }
        });
    }

    /** The screenshot on the page saved into the gallery (Pictures/Astra Remote); answers with a toast. */
    @JavascriptInterface
    public void saveImage(final String base64) {
        ui.post(() -> activity.withStorage(() -> pool.execute(() -> {
            String msg;
            try {
                byte[] jpg = Base64.decode(base64, Base64.DEFAULT);
                String name = "ПК " + new java.text.SimpleDateFormat("yyyy-MM-dd HH-mm-ss", java.util.Locale.US).format(new java.util.Date()) + ".jpg";
                ContentResolver cr = activity.getContentResolver();
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Astra Remote");
                    Uri u = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (u == null) throw new IOException("Не удалось сохранить в галерею");
                    try (OutputStream o = cr.openOutputStream(u)) {
                        o.write(jpg);
                    }
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Astra Remote");
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Нет доступа к галерее");
                    File f = new File(dir, name);
                    try (OutputStream o = new FileOutputStream(f)) {
                        o.write(jpg);
                    }
                    MediaScannerConnection.scanFile(activity, new String[]{f.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
                }
                msg = "Снимок сохранён в галерею";
            } catch (Exception e) {
                msg = message(e);
            }
            js("window.toast&&toast(" + q(msg) + ")");
        })));
    }

    /** A chat message; the reply comes as __chat(id, jsonLine) per line and __chat(id, null) at the end. */
    @JavascriptInterface
    public void chat(final String id, final String text, final boolean fresh) {
        chat(id, text, fresh, false);
    }

    /** The same, asking for Astra's own voice: {"audio": …} lines come with the reply (see __chat). */
    @JavascriptInterface
    public void chat(final String id, final String text, final boolean fresh, final boolean voice) {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        if (n == null || p == null) {
            js("window.__chat(" + q(id) + "," + q("{\"error\":\"Телефон не подключён\"}") + ");window.__chat(" + q(id) + ",null)");
            return;
        }
        pool.execute(() -> {
            HttpsURLConnection c = null;
            try {
                JSONObject b = new JSONObject();
                b.put("text", text);
                b.put("fresh", fresh);
                if (voice) b.put("voice", true);
                c = n.connect("POST", "/api/chat", p.token, b.toString().getBytes(StandardCharsets.UTF_8), 10 * 60 * 1000);
                chatConn = c;
                rememberHost();
                int code = c.getResponseCode();
                if (code >= 400) {
                    Pinned.Response r = Pinned.response(c);
                    if (code == 401) forgetLocally();
                    js("window.__chat(" + q(id) + "," + q("{\"error\":" + q(errorOf(r)) + "}") + ")");
                } else {
                    BufferedReader rd = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                    String line;
                    while ((line = rd.readLine()) != null) {
                        if (!line.isEmpty()) js("window.__chat(" + q(id) + "," + q(line) + ")");
                    }
                }
            } catch (Exception e) {
                if (!chatStopped) js("window.__chat(" + q(id) + "," + q(errorJson(e)) + ")");
            } finally {
                chatStopped = false;
                chatConn = null;
                if (c != null) c.disconnect();
                js("window.__chat(" + q(id) + ",null)");
            }
        });
    }

    @JavascriptInterface
    public void stopChat() {
        HttpsURLConnection c = chatConn;
        chatConn = null;
        if (c != null) chatStopped = true;
        if (c != null) pool.execute(c::disconnect);
    }

    /** Unpair on the PC as well; locally the pairing is gone whatever the PC says. */
    @JavascriptInterface
    public void unpair() {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        pool.execute(() -> {
            if (n != null && p != null) {
                try {
                    n.request("POST", "/api/unpair", p.token, "{}", 8000);
                } catch (Exception ignored) {
                }
            }
            forgetLocally();
        });
    }

    // ── pairing ─────────────────────────────────────────────────────────────

    private static final class Draft {
        Vault.Pairing pairing;
        String secret;
    }

    /** What the QR code on the plugin page carries (see pairLink in the plugin's src/index.ts). */
    static Draft parseQr(String text) {
        if (text == null || text.length() > 4096) throw new IllegalArgumentException("QR-код повреждён");
        Uri u = Uri.parse(text.trim());
        if (!"astraremote".equals(u.getScheme()) || !"pair".equals(u.getHost())) {
            throw new IllegalArgumentException("Это не QR-код Phone Remote");
        }
        if (!"1".equals(u.getQueryParameter("v"))) {
            throw new IllegalArgumentException("QR-код от другой версии плагина — обнови приложение");
        }
        List<String> hosts = validHosts(java.util.Arrays.asList(String.valueOf(u.getQueryParameter("h")).split(",")));
        int port;
        try {
            port = Integer.parseInt(String.valueOf(u.getQueryParameter("p")));
        } catch (NumberFormatException e) {
            port = 0;
        }
        String fp = String.valueOf(u.getQueryParameter("f")).toLowerCase();
        String secret = u.getQueryParameter("s");
        if (port < 1 || port > 65535 || !HEX64.matcher(fp).matches() || secret == null || secret.isEmpty() || secret.length() > 200) {
            throw new IllegalArgumentException("QR-код повреждён. Открой его на ПК заново");
        }
        Draft d = new Draft();
        d.pairing = new Vault.Pairing();
        d.pairing.hosts = hosts.toArray(new String[0]);
        d.pairing.port = port;
        d.pairing.fingerprint = fp;
        String tunnelJson = u.getQueryParameter("t");
        if (tunnelJson != null) {
            try {
                JSONObject t = new JSONObject(tunnelJson);
                String url = t.getString("url"), key = t.getString("key");
                if (t.optInt("v") != 1 || !TunaTunnel.valid(url, key)) throw new IllegalArgumentException();
                d.pairing.tunaUrl = Endpoint.tuna(url); d.pairing.tunaKey = key;
            } catch (Exception e) { throw new IllegalArgumentException("Некорректные настройки TUNA в QR-коде"); }
        }
        if (hosts.isEmpty() && d.pairing.tunaUrl.isEmpty()) throw new IllegalArgumentException("Нет домашнего адреса или TUNA. Открой новый QR-код на ПК");
        String name = u.getQueryParameter("n");
        d.pairing.pcName = name == null || name.trim().isEmpty() ? "ПК" : name.trim().substring(0, Math.min(64, name.trim().length()));
        d.secret = secret;
        return d;
    }

    private void pairEvent(String state, String message, String check) {
        try {
            JSONObject o = new JSONObject();
            o.put("state", state);
            if (message != null) o.put("message", message);
            if (check != null) o.put("check", check);
            event("__pair", o);
        } catch (Exception ignored) {
        }
    }

    /** Open the camera; what it reads comes back to {@link #onScanned}. */
    @JavascriptInterface
    public void scan(final String name) {
        ui.post(() -> {
            pairName = name == null ? "" : name.trim();
            activity.startScan();
        });
    }

    void onScanned(String text) {
        if (text == null) {
            pairEvent("idle", null, null);
            return;
        }
        final Draft d;
        try {
            d = parseQr(text);
        } catch (IllegalArgumentException e) {
            pairEvent("error", e.getMessage(), null);
            return;
        }
        PairAttempt old = attempt;
        if (old != null) old.cancelled = true;
        final PairAttempt a = new PairAttempt();
        attempt = a;
        final String name = pairName.isEmpty() ? deviceName() : pairName;
        pairEvent("connecting", d.pairing.pcName, null);
        pool.execute(() -> {
            // pairing works away from home too, when the PC has a tuna; this one is only for the pairing
            final TunaTunnel pr = TunaTunnel.valid(d.pairing.tunaUrl, d.pairing.tunaKey) ? new TunaTunnel(d.pairing.tunaUrl, d.pairing.tunaKey) : null;
            try {
                Pinned n = new Pinned(d.pairing.hosts, d.pairing.port, d.pairing.fingerprint, "", pr);
                JSONObject req = new JSONObject();
                req.put("secret", d.secret);
                req.put("name", name);
                Pinned.Response r = n.request("POST", "/api/pair", null, req.toString());
                if (r.status != 200) throw new IOException(errorOf(r));
                JSONObject j = new JSONObject(r.text());
                JSONObject poll = new JSONObject();
                poll.put("id", j.getString("id"));
                poll.put("poll", j.getString("poll"));
                pairEvent("wait", d.pairing.pcName, j.optString("check"));
                long until = System.currentTimeMillis() + 5 * 60 * 1000;
                while (!a.cancelled) {
                    if (System.currentTimeMillis() > until) throw new IOException("Время вышло. Нажми «Подключить телефон» на ПК ещё раз");
                    Thread.sleep(1500);
                    if (a.cancelled) return;
                    Pinned.Response w;
                    try {
                        w = n.request("POST", "/api/pair/wait", null, poll.toString(), 10000);
                    } catch (IOException e) {
                        continue; // Wi-Fi hiccup: keep waiting
                    }
                    JSONObject s = new JSONObject(w.text());
                    String st = s.optString("status");
                    if ("ok".equals(st)) {
                        d.pairing.token = s.getString("token");
                        d.pairing.lastHost = n.currentHost();
                        vault.save(d.pairing);
                        setPairing(d.pairing);
                        Remote.prefs(activity).edit().remove("lastNote").remove("widget").apply(); // a new PC: old notes are not news
                        ui.post(() -> {
                            activity.askNotifications();
                            Remote.scheduleNotes(activity);
                        });
                        pairEvent("ok", d.pairing.pcName, null);
                        return;
                    }
                    if ("denied".equals(st)) throw new IOException("На ПК нажали «Отклонить»");
                    if (!"wait".equals(st)) throw new IOException("Запрос на подключение больше не действует. Начни заново на ПК");
                }
            } catch (InterruptedException ignored) {
            } catch (Exception e) {
                if (!a.cancelled) pairEvent("error", message(e), null);
            } finally {
                if (pr != null) pr.close();
                if (attempt == a) attempt = null;
            }
        });
    }

    @JavascriptInterface
    public void cancelPairing() {
        PairAttempt a = attempt;
        if (a != null) a.cancelled = true;
        attempt = null;
    }

    // ── clipboard ───────────────────────────────────────────────────────────

    /** The phone's clipboard as text ("" if none). Android lets an app read it only while in front. */
    @JavascriptInterface
    public String readClipboard() {
        final String[] out = {""};
        final CountDownLatch done = new CountDownLatch(1);
        ui.post(() -> {
            try {
                ClipboardManager cm = activity.getSystemService(ClipboardManager.class);
                ClipData c = cm == null ? null : cm.getPrimaryClip();
                if (c != null && c.getItemCount() > 0) {
                    CharSequence t = c.getItemAt(0).coerceToText(activity);
                    out[0] = t == null ? "" : t.toString();
                }
            } finally {
                done.countDown();
            }
        });
        try {
            done.await();
        } catch (InterruptedException ignored) {
        }
        return out[0];
    }

    @JavascriptInterface
    public void writeClipboard(final String text) {
        ui.post(() -> {
            ClipboardManager cm = activity.getSystemService(ClipboardManager.class);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Phone Remote", text == null ? "" : text));
        });
    }

    // ── files ───────────────────────────────────────────────────────────────

    @JavascriptInterface
    public void pickFiles() {
        ui.post(activity::startPick);
    }

    private void fileEvent(String kind, String name, long done, long total, String extra) {
        try {
            JSONObject o = new JSONObject();
            o.put("kind", kind);
            o.put("name", name);
            o.put("done", done);
            o.put("total", total);
            if (extra != null) o.put("info", extra);
            event("__files", o);
        } catch (Exception ignored) {
        }
    }

    private static final class Progress extends OutputStream {
        private final OutputStream out;
        private final Runnable tick;
        long count;
        private long lastTick;

        Progress(OutputStream out, Runnable tick) {
            this.out = out;
            this.tick = tick;
        }

        @Override public void write(int b) throws IOException {
            out.write(b);
            count++;
        }

        @Override public void write(byte[] b, int off, int len) throws IOException {
            out.write(b, off, len);
            count += len;
            long now = System.currentTimeMillis();
            if (now - lastTick > 250) {
                lastTick = now;
                tick.run();
            }
        }

        @Override public void flush() throws IOException {
            out.flush();
        }

        @Override public void close() throws IOException {
            out.close();
        }
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    // ── voice ───────────────────────────────────────────────────────────────
    // Speaking to Astra goes through the phone's recogniser (MainActivity.startListen); her reply is read
    // out by the phone's own text-to-speech, and the page moves the avatar's mouth while it plays.

    private android.speech.tts.TextToSpeech tts;
    private volatile boolean ttsReady;

    @JavascriptInterface
    public void listen() {
        ui.post(activity::startListen);
    }

    void onHeard(String text, String error) {
        try {
            JSONObject o = new JSONObject();
            if (text != null) o.put("text", text);
            if (error != null) o.put("error", error);
            event("__heard", o);
        } catch (Exception ignored) {
        }
    }

    private void speakingEvent(boolean on) {
        js("window.__speaking&&window.__speaking(" + on + ")");
    }

    @JavascriptInterface
    public void speak(final String text) {
        ui.post(() -> {
            if (text == null || text.trim().isEmpty()) return;
            if (tts == null) {
                tts = new android.speech.tts.TextToSpeech(activity, status -> {
                    ttsReady = status == android.speech.tts.TextToSpeech.SUCCESS;
                    if (ttsReady) {
                        tts.setLanguage(new java.util.Locale("ru", "RU"));
                        tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                            @Override public void onStart(String id) { speakingEvent(true); }
                            @Override public void onDone(String id) { if (!tts.isSpeaking()) speakingEvent(false); }
                            @Override public void onError(String id) { speakingEvent(false); }
                        });
                        say(text);
                    }
                });
            } else if (ttsReady) {
                say(text);
            }
        });
    }

    private void say(String text) {
        // the engine takes a few thousand characters at a time: long replies go in pieces
        String t = text.replaceAll("[*_`#>]+", " ");
        int max = Math.max(500, android.speech.tts.TextToSpeech.getMaxSpeechInputLength() - 100);
        boolean first = true;
        for (int i = 0; i < t.length(); i += max) {
            tts.speak(t.substring(i, Math.min(t.length(), i + max)), first ? android.speech.tts.TextToSpeech.QUEUE_FLUSH : android.speech.tts.TextToSpeech.QUEUE_ADD,
                    null, "astra-" + i);
            first = false;
        }
    }

    @JavascriptInterface
    public void stopSpeaking() {
        ui.post(() -> {
            if (tts != null) tts.stop();
            speakingEvent(false);
        });
    }

    // ── the avatar ──────────────────────────────────────────────────────────
    // The model the character wears in Astra and its pack's motions, kept in the app's own private folder
    // (no other app reads it, it is not backed up) and gone when the phone is unpaired. The model comes
    // down once: it is asked for again only when its SHA-256 on the PC changes.

    private static final Pattern CLIP_NAME = Pattern.compile("^[A-Za-z0-9_.-]{1,80}$");

    File avatarDir() {
        return new File(activity.getFilesDir(), "avatar");
    }

    /** The file behind a page URL /avatar/…, or null: only the model and clips/<name>.vrma exist there. */
    File avatarFile(String rel) {
        if ("model.vrm".equals(rel)) return new File(avatarDir(), "model.vrm");
        if (rel != null && rel.startsWith("clips/") && rel.endsWith(".vrma")) {
            String name = rel.substring(6, rel.length() - 5);
            if (CLIP_NAME.matcher(name).matches()) return new File(new File(avatarDir(), "clips"), name + ".vrma");
        }
        return null;
    }

    private static String readStamp(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            return new String(Pinned.readAll(in), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return "";
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /**
     * Make sure the model ("model") or a motion ("clip", name) is here, fetching it if its stamp (the
     * model's SHA-256, a clip's size) differs; answers __native(id, 200, page URL). The model's progress
     * comes as __avatarProgress(done, total).
     */
    @JavascriptInterface
    public void avatarFetch(final String id, final String what, final String name, final String stamp) {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        if (n == null || p == null) {
            js("window.__native(" + q(id) + ",401,\"\")");
            return;
        }
        pool.execute(() -> {
            HttpsURLConnection c = null;
            try {
                boolean model = "model".equals(what);
                if (!model && !CLIP_NAME.matcher(String.valueOf(name)).matches()) throw new IOException("bad clip name");
                String rel = model ? "model.vrm" : "clips/" + name + ".vrma";
                File f = avatarFile(rel);
                File st = new File(f.getPath() + ".stamp");
                if (!(f.isFile() && String.valueOf(stamp).equals(readStamp(st)))) {
                    //noinspection ResultOfMethodCallIgnored
                    f.getParentFile().mkdirs();
                    c = n.connect("GET", model ? "/api/avatar/model" : "/api/avatar/clip?name=" + URLEncoder.encode(name, "UTF-8"), p.token, null, 120000);
                    int code = c.getResponseCode();
                    if (code != 200) {
                        Pinned.Response r = Pinned.response(c);
                        if (code == 401) forgetLocally();
                        throw new IOException(errorOf(r));
                    }
                    final long total = c.getContentLengthLong();
                    File tmp = new File(f.getPath() + ".part");
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                        final Progress[] pr = new Progress[1];
                        pr[0] = new Progress(out, () -> {
                            if (model) js("window.__avatarProgress&&window.__avatarProgress(" + pr[0].count + "," + total + ")");
                        });
                        copy(in, pr[0]);
                    }
                    if (f.exists() && !f.delete() || !tmp.renameTo(f)) throw new IOException("Не удалось сохранить модель");
                    try (OutputStream o = new FileOutputStream(st)) {
                        o.write(String.valueOf(stamp).getBytes(StandardCharsets.UTF_8));
                    }
                }
                js("window.__native(" + q(id) + ",200," + q("https://" + MainActivity.HOST + "/avatar/" + rel) + ")");
            } catch (Exception e) {
                js("window.__native(" + q(id) + ",0," + q(errorJson(e)) + ")");
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    /** Files picked in the app or shared to it from another app: each goes to the PC's shared folder. */
    void upload(final List<Uri> uris) {
        whenReady(() -> {
            if (net == null) {
                fileEvent("error", "", 0, 0, "Сначала подключи телефон к ПК");
                return;
            }
            fileEvent("queued", "", 0, uris.size(), null);
            for (final Uri uri : uris) transfers.execute(() -> uploadOne(uri));
        });
    }

    private void uploadOne(Uri uri) {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        String name = "file";
        long size = -1;
        ContentResolver cr = activity.getContentResolver();
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        } catch (Exception ignored) {
        }
        final String fname = name;
        final long total = size;
        if (n == null || p == null) {
            fileEvent("upError", fname, 0, total, "Телефон не подключён");
            return;
        }
        HttpsURLConnection conn = null;
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) throw new IOException("Файл не открывается");
            if (total > 0) {
                // ask for the PC's limit first: a refused upload would otherwise send the whole file for nothing
                Pinned.Response lim = n.request("GET", "/api/files?path=", p.token, null);
                if (lim.status == 401) forgetLocally();
                if (lim.status != 200) throw new IOException(errorOf(lim));
                long max = new JSONObject(lim.text()).optLong("maxBytes", Long.MAX_VALUE);
                if (total > max) throw new IOException("Файл больше " + (max / 1048576) + " МБ — лимит в настройках плагина на ПК");
            }
            final Progress[] pr = new Progress[1];
            String path = "/api/files/upload?name=" + URLEncoder.encode(fname, "UTF-8");
            fileEvent("up", fname, 0, total, null);
            conn = n.connect("POST", path, p.token, "application/octet-stream", total, out -> {
                pr[0] = new Progress(out, () -> fileEvent("up", fname, pr[0].count, total, null));
                copy(in, pr[0]);
                pr[0].flush();
            }, 120000);
            Pinned.Response r = Pinned.response(conn);
            if (r.status == 401) forgetLocally();
            if (r.status != 200) throw new IOException(errorOf(r));
            fileEvent("upDone", fname, total, total, new JSONObject(r.text()).optString("saved", fname));
        } catch (Exception e) {
            fileEvent("upError", fname, 0, total, message(e));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Fetch a file from the PC's shared folder into Downloads/Astra Remote on the phone. */
    @JavascriptInterface
    public void download(final String path, final String name) {
        final Pinned n = net;
        final Vault.Pairing p = pairing;
        if (n == null || p == null) return;
        final String fname = safeName(name);
        ui.post(() -> activity.withStorage(() -> transfers.execute(() -> downloadOne(n, p, path, fname))));
    }

    @JavascriptInterface
    public void downloadAllowed(final String root, final String path, final String name) {
        final Pinned n = net; final Vault.Pairing p = pairing;
        if (n == null || p == null || root == null || path == null || root.length() > 128 || path.length() > 4096) return;
        final String fname = safeName(name);
        try {
            final String route = "/api/library/download?root=" + URLEncoder.encode(root, "UTF-8") + "&path=" + URLEncoder.encode(path, "UTF-8");
            ui.post(() -> activity.withStorage(() -> transfers.execute(() -> downloadRoute(n, p, route, fname))));
        } catch (java.io.UnsupportedEncodingException ignored) {}
    }

    @JavascriptInterface
    public void remoteScreen(final boolean on) {
        ui.post(() -> activity.remoteScreen(on));
    }

    private void downloadOne(Pinned n, Vault.Pairing p, String path, String fname) {
        try {
            downloadRoute(n, p, "/api/files/download?path=" + URLEncoder.encode(path, "UTF-8"), fname);
        } catch (java.io.UnsupportedEncodingException ignored) {}
    }

    private void downloadRoute(Pinned n, Vault.Pairing p, String route, String fname) {
        HttpsURLConnection conn = null;
        Uri target = null;
        try {
            conn = n.connect("GET", route, p.token, null, 120000);
            int code = conn.getResponseCode();
            if (code != 200) {
                Pinned.Response r = Pinned.response(conn);
                if (code == 401) forgetLocally();
                throw new IOException(errorOf(r));
            }
            final long total = conn.getContentLengthLong();
            fileEvent("down", fname, 0, total, null);
            String mime = mimeOf(fname);
            File legacy = null;
            OutputStream os;
            ContentResolver cr = activity.getContentResolver();
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, fname);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Astra Remote");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                target = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (target == null) throw new IOException("Не удалось создать файл в «Загрузках»");
                os = cr.openOutputStream(target);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Astra Remote");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Нет доступа к «Загрузкам»: разреши приложению доступ к файлам");
                legacy = unique(dir, fname);
                os = new FileOutputStream(legacy);
            }
            try (InputStream in = conn.getInputStream(); OutputStream out = os) {
                final Progress[] pr = new Progress[1];
                pr[0] = new Progress(out, () -> fileEvent("down", fname, pr[0].count, total, null));
                copy(in, pr[0]);
            }
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(target, v, null, null);
                fileEvent("downDone", fname, total, total, target.toString());
            } else {
                final File f = legacy;
                MediaScannerConnection.scanFile(activity, new String[]{f.getAbsolutePath()}, new String[]{mime},
                        (pth, uri) -> fileEvent("downDone", fname, total, total, uri == null ? "" : uri.toString()));
            }
            target = null;
        } catch (Exception e) {
            fileEvent("downError", fname, 0, 0, message(e));
        } finally {
            if (conn != null) conn.disconnect();
            if (target != null) activity.getContentResolver().delete(target, null, null); // a half-written download
        }
    }

    private static String safeName(String name) {
        String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        return s.isEmpty() || s.equals(".") || s.equals("..") ? "file" : s;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; f.exists(); i++) f = new File(dir, base + " (" + i + ")" + ext);
        return f;
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String m = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
        return m == null ? "application/octet-stream" : m;
    }

    @JavascriptInterface
    public void shareDownloaded(final String uri) {
        ui.post(() -> {
            if (uri == null || !uri.startsWith("content://")) return;
            Uri u = Uri.parse(uri);
            String type = activity.getContentResolver().getType(u);
            Intent intent = new Intent(Intent.ACTION_SEND).setType(type == null ? "application/octet-stream" : type)
                    .putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { activity.startActivity(Intent.createChooser(intent, "Отправить файл")); }
            catch (Exception e) { fileEvent("downError", "", 0, 0, "Не удалось открыть меню отправки"); }
        });
    }

    /** Open a downloaded file in whatever app handles it. */
    @JavascriptInterface
    public void openDownloaded(final String uri) {
        ui.post(() -> {
            if (uri == null || !uri.startsWith("content://")) return;
            Uri u = Uri.parse(uri);
            String type = activity.getContentResolver().getType(u);
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, type == null ? "*/*" : type)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                activity.startActivity(Intent.createChooser(i, "Открыть"));
            } catch (Exception e) {
                fileEvent("downError", "", 0, 0, "Нет приложения, которое открывает такой файл");
            }
        });
    }

    // ── shared from other apps ──────────────────────────────────────────────

    /** Text or a link shared to the app: the page offers what to do with it. */
    void onSharedText(final String text) {
        whenReady(() -> {
            try {
                JSONObject o = new JSONObject();
                o.put("text", text);
                event("__shared", o);
            } catch (Exception ignored) {
            }
        });
    }
}
