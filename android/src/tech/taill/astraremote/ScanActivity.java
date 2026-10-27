package tech.taill.astraremote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the pairing QR code from the plugin page. Only the text goes back to {@link MainActivity};
 * nothing is saved or sent from here. The old Camera API is plenty for a preview and needs a tenth of
 * the code Camera2 would.
 */
@SuppressWarnings("deprecation")
public final class ScanActivity extends Activity implements TextureView.SurfaceTextureListener, Camera.PreviewCallback {
    private static final int REQ_CAMERA = 1;

    private TextureView view;
    private TextView hint;
    private Camera camera;
    private int previewW, previewH, rotation;
    private HandlerThread thread;
    private Handler worker;
    private volatile boolean busy, done;
    private final QRCodeReader reader = new QRCodeReader();
    private final Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new TextureView(this);
        view.setSurfaceTextureListener(this);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));

        // a frame to aim with
        View frame = new View(this);
        GradientDrawable g = new GradientDrawable();
        g.setStroke(dp(3), 0xffffffff);
        g.setCornerRadius(dp(18));
        frame.setBackground(g);
        FrameLayout.LayoutParams fl = new FrameLayout.LayoutParams(dp(250), dp(250), Gravity.CENTER);
        root.addView(frame, fl);

        hint = new TextView(this);
        hint.setText("Наведи камеру на QR-код на странице Phone Remote в Astra");
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(dp(24), dp(14), dp(24), dp(14));
        hint.setBackgroundColor(0x99000000);
        root.addView(hint, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));

        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextColor(Color.WHITE);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        close.setPadding(dp(18), dp(36), dp(18), dp(18));
        close.setOnClickListener(v -> finish());
        root.addView(close, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        setContentView(root);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        thread = new HandlerThread("qr");
        thread.start();
        worker = new Handler(thread.getLooper());
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        } else if (view.isAvailable()) {
            open();
        }
    }

    @Override
    protected void onPause() {
        close();
        thread.quitSafely();
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_CAMERA) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            if (view.isAvailable()) open();
        } else {
            hint.setText("Без доступа к камере QR-код не прочитать. Разреши камеру в настройках Android → Приложения → Phone Remote");
        }
    }

    private void open() {
        if (camera != null) return;
        try {
            int id = 0;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
                Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                    id = i;
                    break;
                }
            }
            Camera.getCameraInfo(id, info);
            camera = Camera.open(id);
            Camera.Parameters p = camera.getParameters();
            Camera.Size best = null;
            for (Camera.Size s : p.getSupportedPreviewSizes()) {
                if (s.width > 1920) continue;
                if (best == null || Math.abs(s.width * s.height - 1280 * 720) < Math.abs(best.width * best.height - 1280 * 720)) best = s;
            }
            if (best != null) p.setPreviewSize(best.width, best.height);
            List<String> modes = p.getSupportedFocusModes();
            if (modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            else if (modes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
            camera.setParameters(p);
            Camera.Size size = camera.getParameters().getPreviewSize();
            previewW = size.width;
            previewH = size.height;

            int degrees = 0;
            switch (getWindowManager().getDefaultDisplay().getRotation()) {
                case Surface.ROTATION_90: degrees = 90; break;
                case Surface.ROTATION_180: degrees = 180; break;
                case Surface.ROTATION_270: degrees = 270; break;
            }
            rotation = (info.orientation - degrees + 360) % 360;
            camera.setDisplayOrientation(rotation);
            fit();
            camera.setPreviewTexture(view.getSurfaceTexture());
            int bytes = previewW * previewH * 3 / 2;
            camera.addCallbackBuffer(new byte[bytes]);
            camera.addCallbackBuffer(new byte[bytes]);
            camera.setPreviewCallbackWithBuffer(this);
            camera.startPreview();
        } catch (Exception e) {
            close();
            hint.setText("Камера не открылась: " + e.getMessage());
        }
    }

    /** Fill the screen without stretching: crop the preview around the centre. */
    private void fit() {
        int vw = view.getWidth(), vh = view.getHeight();
        if (vw == 0 || vh == 0 || previewW == 0) return;
        float sw = rotation % 180 == 0 ? previewW : previewH;
        float sh = rotation % 180 == 0 ? previewH : previewW;
        float scale = Math.max(vw / sw, vh / sh);
        Matrix m = new Matrix();
        m.setScale(sw * scale / vw, sh * scale / vh, vw / 2f, vh / 2f);
        view.setTransform(m);
    }

    private void close() {
        if (camera == null) return;
        camera.setPreviewCallbackWithBuffer(null);
        camera.stopPreview();
        camera.release();
        camera = null;
    }

    @Override
    public void onPreviewFrame(final byte[] data, final Camera cam) {
        if (done || busy || worker == null) {
            if (camera != null) camera.addCallbackBuffer(data);
            return;
        }
        busy = true;
        final int w = previewW, h = previewH;
        worker.post(() -> {
            String text = null;
            try {
                // QR codes read in any orientation, so the frame is decoded as the sensor gives it
                PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false);
                Result r = reader.decode(new BinaryBitmap(new HybridBinarizer(src)), hints);
                text = r.getText();
            } catch (Exception ignored) {
                // nothing in this frame
            } finally {
                reader.reset();
            }
            final String found = text;
            runOnUiThread(() -> {
                busy = false;
                if (camera != null) camera.addCallbackBuffer(data);
                if (found != null) onFound(found);
            });
        });
    }

    private void onFound(String text) {
        if (done) return;
        if (!text.startsWith("astraremote://pair?")) {
            hint.setText("Это другой QR-код. Нужен код со страницы Phone Remote в Astra на ПК");
            return;
        }
        done = true;
        Vibrator v = getSystemService(Vibrator.class);
        if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE));
        setResult(RESULT_OK, new Intent().putExtra("text", text));
        finish();
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) open();
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
        fit();
    }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
        close();
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture surface) {
    }
}
