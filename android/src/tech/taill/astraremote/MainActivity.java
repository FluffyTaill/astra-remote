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
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * One screen: a WebView with the app's page from assets, which reaches the PC only through {@link Bridge}.
 * Also the app lock: after a minute in the background the page is covered until the owner unlocks the
 * phone's way (fingerprint, face, PIN).
 */
public final class MainActivity extends Activity {
    private static final int REQ_SCAN = 1, REQ_PICK = 2, REQ_UNLOCK = 3, REQ_STORAGE = 4;
    private static final long LOCK_AFTER_MS = 60_000;
    private static final int BG = 0xff0e1017;

    private WebView web;
    private Bridge bridge;
    private View cover;
    private SharedPreferences settings;
    private boolean locked;
    private long backgroundedAt;
    private Intent pendingShare;
    private Runnable afterStorage;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // the PC's screenshots and chat stay out of the recent-apps preview and screen recordings
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(0xff171a24);
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
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); // file:///android_asset/ still loads; nothing else on the phone does
        s.setAllowContentAccess(false);
        s.setBlockNetworkLoads(true); // the page itself never goes online
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setSupportZoom(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // the page is the whole app: no navigating away
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
        web.loadUrl("file:///android_asset/index.html");
        if (locked) unlock();
        handleShare(getIntent());
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
        title.setText("Astra Remote заблокирован");
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
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(this).setTitle("Astra Remote");
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
            Intent i = km.createConfirmDeviceCredentialIntent("Astra Remote", "Разблокируй, чтобы открыть пульт");
            if (i == null) unlocked();
            else startActivityForResult(i, REQ_UNLOCK);
        }
    }

    // ── other screens ───────────────────────────────────────────────────────

    void startScan() {
        startActivityForResult(new Intent(this, ScanActivity.class), REQ_SCAN);
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
