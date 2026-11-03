package tech.taill.astraremote;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLSocket;

/** Ordered, bounded input channel inside the same certificate-pinned TLS as the HTTP API. */
final class InputChannel {
    interface Listener {
        void message(String json);
        void ended(String error);
    }
    private final Pinned pinned;
    private final String token;
    private final Listener listener;
    private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(16);
    private final AtomicBoolean stopped = new AtomicBoolean();
    private final AtomicBoolean reported = new AtomicBoolean();
    private volatile SSLSocket socket;
    private volatile Thread writer;
    private volatile boolean ready;

    InputChannel(Pinned pinned, String token, Listener listener) {
        this.pinned = pinned; this.token = token; this.listener = listener;
    }
    void start() {
        Thread thread = new Thread(this::run, "input-reader");
        thread.setDaemon(true); thread.start();
    }
    boolean send(String json) {
        if (stopped.get() || !ready || json == null || json.length() > 30000) return false;
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        return bytes.length <= 32768 && queue.offer(bytes);
    }
    void close() {
        if (!stopped.compareAndSet(false, true)) return;
        ready = false; queue.clear();
        Thread w = writer; if (w != null) w.interrupt();
        SSLSocket s = socket;
        // TLS close_notify is network I/O, including when called from Activity.onDestroy.
        if (s != null) {
            Thread closer = new Thread(() -> closeSocket(s), "input-close");
            closer.setDaemon(true); closer.start();
        }
    }
    private void run() {
        String error = "Соединение тачпада закрыто";
        try {
            SSLSocket s = pinned.inputSocket(); socket = s;
            if (stopped.get()) { closeSocket(s); return; }
            s.setSoTimeout(30000);
            OutputStream out = s.getOutputStream();
            byte[] nonce = new byte[16]; new SecureRandom().nextBytes(nonce);
            String challenge = Base64.getEncoder().encodeToString(nonce);
            String request = "GET /api/input/stream HTTP/1.1\r\nHost: " + s.getInetAddress().getHostAddress()
                    + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "
                    + challenge + "\r\nAuthorization: Bearer " + token + "\r\n\r\n";
            out.write(request.getBytes(StandardCharsets.US_ASCII)); out.flush();
            TunaTunnel.verifyUpgrade(s.getInputStream(), challenge);
            s.setSoTimeout(60000);
            ready = true;
            writer = new Thread(() -> {
                try {
                    while (!stopped.get()) {
                        byte[] bytes = queue.take();
                        synchronized (out) { TunaTunnel.writeFrame(out, 2, bytes, 0, bytes.length); }
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } catch (IOException e) { close(); }
            }, "input-writer");
            writer.setDaemon(true); writer.start();
            TunaTunnel.readFrames(s.getInputStream(), out, new OutputStream() {
                private final ByteArrayOutputStream line = new ByteArrayOutputStream();
                @Override public void write(int b) throws IOException {
                    if (b == '\n') {
                        String json = new String(line.toByteArray(), StandardCharsets.UTF_8);
                        line.reset(); if (!json.isEmpty() && !stopped.get()) listener.message(json);
                    } else {
                        if (line.size() >= 8192) throw new IOException("Input response too large");
                        line.write(b);
                    }
                }
                @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                    for (int i = offset; i < offset + length; i++) write(bytes[i] & 255);
                }
            });
        } catch (IOException | RuntimeException e) {
            error = e.getMessage() == null ? "ПК не отвечает" : e.getMessage();
        } finally {
            close();
            if (reported.compareAndSet(false, true)) listener.ended(error);
        }
    }
    private static void closeSocket(SSLSocket socket) {
        try { socket.close(); } catch (IOException ignored) {}
    }
}
