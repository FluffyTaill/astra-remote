package tech.taill.astraremote;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * One screen: a WebView with the app's page from assets, which reaches the PC only through {@link Bridge}.
 * Also the app lock: after a minute in the background the page is covered until the owner unlocks the
 * phone's way (fingerprint, face, PIN).
 */
public final class MainActivity extends Activity {
    private static final int REQ_SCAN = 1, REQ_PICK = 2, REQ_UNLOCK = 3, REQ_STORAGE = 4, REQ_SPEECH = 5, REQ_NOTIFY = 6;
    private static final long LOCK_AFTER_MS = 60_000;
    private static final int BG = 0xff17181b;
    // The page's own origin. Nothing behind it is online: every request to it is answered here, from the
    // app's assets or its private avatar folder, and any other address is refused (see intercept()).
    static final String HOST = "appassets.androidplatform.net";

    private WebView web;
    private Bridge bridge;
    private View cover;
    private SharedPreferences settings;
    private boolean locked;
    private long backgroundedAt;
    private Intent pendingShare;
    private Runnable afterStorage;

    // A crash is written down and shown on the next start, so it can be reported without a cable and logcat.
    private static final String CRASH = "crash.txt";

    private void watchCrashes() {
        final Thread.UncaughtExceptionHandler next = Thread.getDefaultUncaughtExceptionHandler();
        final File f = new File(getFilesDir(), CRASH);
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try (java.io.PrintWriter w = new java.io.PrintWriter(new java.io.FileWriter(f))) {
                w.println("Phone Remote " + BuildInfo.version(this) + ", Android " + Build.VERSION.RELEASE + ", " + Build.MANUFACTURER + " " + Build.MODEL);
                e.printStackTrace(w);
            } catch (Exception ignored) {
            }
            if (next != null) next.uncaughtException(t, e);
        });
    }

    private void showLastCrash() {
        File f = new File(getFilesDir(), CRASH);
        if (!f.isFile()) return;
        String text;
        try (InputStream in = new FileInputStream(f)) {
            text = new String(Pinned.readAll(in), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            text = String.valueOf(e);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        final String report = text;
        new android.app.AlertDialog.Builder(this)
                .setTitle("Прошлый запуск завершился ошибкой")
                .setMessage("Отправь этот текст разработчику — по нему видно, что сломалось.\n\n" + report.substring(0, Math.min(report.length(), 2500)))
                .setPositiveButton("Скопировать", (d, w) -> {
                    android.content.ClipboardManager cm = getSystemService(android.content.ClipboardManager.class);
                    if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("Phone Remote crash", report));
                })
                .setNegativeButton("Закрыть", null)
                .show();
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        watchCrashes();
        settings = getSharedPreferences("settings", MODE_PRIVATE);
        // the PC's screenshots and chat stay out of the recent-apps preview and screen recordings,
        // unless the owner allowed screenshots of the app in its settings
        applySecure();
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        settings = getSharedPreferences("settings", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        if (Build.VERSION.SDK_INT >= 30) {
            // one layout on every version: the page sits between the system bars and above the keyboard
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setMediaPlaybackRequiresUserGesture(false); // Astra's voice starts when her reply comes, not on a tap
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); // file:///android_asset/ still loads; nothing else on the phone does
        s.setAllowContentAccess(false);
        // the page never goes online: whatever it asks for is answered in intercept(), and that refuses
        // every address but the app's own (three.js needs a real https origin to load the avatar)
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setSupportZoom(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // the page is the whole app: no navigating away
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return intercept(request.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient()); // confirm() dialogs
        bridge = new Bridge(this, web, new Vault(this));
        web.addJavascriptInterface(bridge, "AR");
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        cover = buildCover();
        root.addView(cover, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        locked = lockEnabled() && lockAvailable();
        cover.setVisibility(locked ? View.VISIBLE : View.GONE);
        web.loadUrl("https://" + HOST + "/assets/index.html");
        if (locked) unlock();
        handleShare(getIntent());
        showLastCrash();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleShare(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (!locked && backgroundedAt > 0 && lockEnabled() && lockAvailable()
                && SystemClock.elapsedRealtime() - backgroundedAt > LOCK_AFTER_MS) {
            locked = true;
            cover.setVisibility(View.VISIBLE);
            unlock();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        backgroundedAt = SystemClock.elapsedRealtime();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        bridge.shutdown();
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (locked) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.__back?window.__back():false", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }

    // ── app lock ────────────────────────────────────────────────────────────

    boolean screenshotsAllowed() {
        return settings.getBoolean("shots", false);
    }

    void setScreenshotsAllowed(boolean on) {
        settings.edit().putBoolean("shots", on).apply();
        applySecure();
    }

    private void applySecure() {
        if (screenshotsAllowed()) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    /** The phone's own folder for files from the PC (Downloads/Astra Remote), in its file manager. */
    void openPhoneFolder() {
        Uri dir = android.provider.DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download/Astra Remote");
        try {
            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(dir, "vnd.android.document/directory")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch (Exception e) {
            try {
                startActivity(new Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS));
            } catch (Exception ignored) {
                android.widget.Toast.makeText(this, "Файлы с ПК лежат в «Загрузки/Astra Remote»", android.widget.Toast.LENGTH_LONG).show();
            }
        }
    }

    boolean lockEnabled() {
        return settings.getBoolean("lock", true);
    }

    void setLockEnabled(boolean on) {
        settings.edit().putBoolean("lock", on).apply();
    }

    /** A lock only means something when the phone itself has a PIN, pattern or password. */
    boolean lockAvailable() {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    private View buildCover() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setClickable(true); // swallow taps meant for the page underneath
        TextView title = new TextView(this);
        title.setText("Phone Remote заблокирован");
        title.setTextColor(0xffeceef5);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        title.setGravity(Gravity.CENTER);
        TextView hint = new TextView(this);
        hint.setText("Разблокируй так же, как телефон");
        hint.setTextColor(0xff8b92a6);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(6), 0, dp(22));
        Button go = new Button(this);
        go.setText("Разблокировать");
        go.setTextColor(Color.WHITE);
        go.setBackgroundColor(0xff8b7cff);
        go.setPadding(dp(24), dp(10), dp(24), dp(10));
        go.setOnClickListener(v -> unlock());
        box.addView(title);
        box.addView(hint);
        box.addView(go);
        return box;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void unlocked() {
        locked = false;
        cover.setVisibility(View.GONE);
        if (pendingShare != null) {
            Intent i = pendingShare;
            pendingShare = null;
            handleShare(i);
        }
    }

    @SuppressWarnings("deprecation")
    private void unlock() {
        if (!lockAvailable()) {
            unlocked();
            return;
        }
        if (Build.VERSION.SDK_INT >= 28) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(this).setTitle("Phone Remote");
            if (Build.VERSION.SDK_INT >= 30) {
                b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                b.setDeviceCredentialAllowed(true);
            }
            b.build().authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    unlocked();
                }
            });
        } else {
            KeyguardManager km = getSystemService(KeyguardManager.class);
            Intent i = km.createConfirmDeviceCredentialIntent("Phone Remote", "Разблокируй, чтобы открыть пульт");
            if (i == null) unlocked();
            else startActivityForResult(i, REQ_UNLOCK);
        }
    }

    // ── the page's files ────────────────────────────────────────────────────

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private WebResourceResponse respond(int code, String type, InputStream body) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        String reason = code == 200 ? "OK" : code == 404 ? "Not Found" : "Forbidden";
        return new WebResourceResponse(type, code == 200 && type.startsWith("text/") ? "utf-8" : null, code, reason, h,
                body != null ? body : new ByteArrayInputStream(new byte[0]));
    }

    /** https://HOST/assets/… from the APK, https://HOST/avatar/… from the private folder; nothing else. */
    WebResourceResponse intercept(Uri u) {
        if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost()) || u.getPath() == null) return respond(403, "text/plain", null);
        String path = u.getPath();
        try {
            if (path.startsWith("/assets/") && !path.contains("..")) {
                String rel = path.substring("/assets/".length());
                return respond(200, mime(rel), getAssets().open(rel));
            }
            if (path.startsWith("/avatar/")) {
                File f = bridge.avatarFile(path.substring("/avatar/".length()));
                if (f != null && f.isFile()) return respond(200, mime(f.getName()), new FileInputStream(f));
            }
        } catch (Exception ignored) {
        }
        return respond(404, "text/plain", null);
    }

    // ── other screens ───────────────────────────────────────────────────────

    void startScan() {
        startActivityForResult(new Intent(this, ScanActivity.class), REQ_SCAN);
    }

    /** Speech to text with the phone's own recogniser (Google's, as a rule); the app needs no microphone permission. */
    void startListen() {
        Intent i = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
                .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Скажи Astra");
        try {
            startActivityForResult(i, REQ_SPEECH);
        } catch (Exception e) {
            bridge.onHeard(null, "На телефоне нет распознавания речи (нужно приложение Google)");
        }
    }

    /** Android 13+ asks before an app may post notifications. */
    void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    void startPick() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(i, REQ_PICK);
    }

    /** Android 8–9 need a permission to write to Downloads; 10+ do not. */
    void withStorage(Runnable r) {
        if (Build.VERSION.SDK_INT >= 29 || checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            r.run();
            return;
        }
        afterStorage = r;
        requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_STORAGE) {
            Runnable r = afterStorage;
            afterStorage = null;
            if (r != null) r.run(); // without the permission the download reports the error itself
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SCAN) {
            bridge.onScanned(resultCode == RESULT_OK && data != null ? data.getStringExtra("text") : null);
        } else if (requestCode == REQ_PICK) {
            if (resultCode != RESULT_OK || data == null) return;
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            if (!uris.isEmpty()) bridge.upload(uris);
        } else if (requestCode == REQ_UNLOCK) {
            if (resultCode == RESULT_OK) unlocked();
        } else if (requestCode == REQ_SPEECH) {
            ArrayList<String> heard = resultCode == RESULT_OK && data != null
                    ? data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS) : null;
            bridge.onHeard(heard == null || heard.isEmpty() ? null : heard.get(0), null);
        }
    }

    // ── "Share" from other apps ─────────────────────────────────────────────

    @SuppressWarnings("deprecation")
    private void handleShare(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        setIntent(new Intent(Intent.ACTION_MAIN)); // handled once, not again on rotation
        if (locked) {
            pendingShare = intent;
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        }
        if (!uris.isEmpty()) {
            bridge.upload(uris);
            return;
        }
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0) bridge.onSharedText(text.toString());
    }
}
