package tech.taill.astraremote;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Outer WSS carries opaque, certificate-pinned PC TLS. No API credentials go into WSS headers. */
final class TunaTunnel {
    static final String HOST = "tuna";
    static final String OFFLINE = "TUNA недоступна. Проверь туннель в TUNA Desktop и запуск Astra на ПК";
    private static final int MAX_FRAME = 256 * 1024;
    private static final SecureRandom RNG = new SecureRandom();
    private final String url, key;
    private final Set<Socket> sockets = new HashSet<>();
    private final Semaphore slots = new Semaphore(24);
    private ServerSocket local;
    private volatile boolean stopped;
    volatile boolean offline;

    TunaTunnel(String url, String key) {
        if (!valid(url, key)) throw new IllegalArgumentException("Некорректные настройки TUNA");
        this.url = Endpoint.tuna(url); this.key = key;
    }
    static boolean valid(String url, String key) { return Endpoint.tuna(url) != null && key != null && key.matches("[a-f0-9]{64}"); }
    boolean same(String url, String key) { return this.url.equals(Endpoint.tuna(url)) && this.key.equals(key) && !stopped; }
    synchronized int port() throws IOException {
        if (stopped) throw new IOException(OFFLINE);
        if (local == null) {
            local = new ServerSocket(0, 24, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(this::acceptLoop, "tuna-accept"); t.setDaemon(true); t.start();
        }
        return local.getLocalPort();
    }
    synchronized void close() {
        if (stopped) return;
        stopped = true;
        try { if (local != null) local.close(); } catch (IOException ignored) {}
        // SSLSocket.close() writes TLS close_notify: it must never run on the UI thread
        // (onDestroy and pairing replacement both call here). Detach before closing so
        // worker cleanup cannot mutate the set while it is being iterated.
        Socket[] pending = sockets.toArray(new Socket[0]);
        sockets.clear();
        Thread closer = new Thread(() -> {
            for (Socket s : pending) closeSocket(s);
        }, "tuna-close");
        closer.setDaemon(true); closer.start();
    }
    private synchronized boolean track(Socket s) {
        if (stopped) { closeSocket(s); return false; }
        sockets.add(s); return true;
    }
    private synchronized void untrack(Socket s) { sockets.remove(s); closeSocket(s); }
    private void acceptLoop() {
        while (!stopped) {
            try {
                Socket app = local.accept();
                if (!slots.tryAcquire()) { closeSocket(app); continue; }
                if (!track(app)) { slots.release(); continue; }
                Thread t = new Thread(() -> { try { pipe(app); } finally { untrack(app); slots.release(); } }, "tuna-up");
                t.setDaemon(true); t.start();
            } catch (IOException e) { if (!stopped) close(); return; }
        }
    }
    private void pipe(Socket app) {
        Socket ws = null;
        try {
            ws = open(); offline = false;
            final Socket remote = ws;
            final InputStream remoteIn = ws.getInputStream();
            final OutputStream remoteOut = ws.getOutputStream(), appOut = app.getOutputStream();
            Thread down = new Thread(() -> {
                try { readFrames(remoteIn, remoteOut, appOut); } catch (IOException ignored) {}
                finally { closeSocket(app); untrack(remote); }
            }, "tuna-down");
            down.setDaemon(true); down.start();
            byte[] buffer = new byte[16384]; int n;
            InputStream in = app.getInputStream();
            while ((n = in.read(buffer)) != -1) synchronized (remoteOut) { writeFrame(remoteOut, 2, buffer, 0, n); }
        } catch (IOException e) { offline = true; }
        finally { closeSocket(app); if (ws != null) untrack(ws); }
    }
    private Socket open() throws IOException {
        String host = URI.create(url).getHost();
        SSLSocket s = (SSLSocket) SSLSocketFactory.getDefault().createSocket();
        if (!track(s)) throw new IOException(OFFLINE);
        try {
            s.connect(new InetSocketAddress(host, 443), 5000); s.setSoTimeout(10000);
            SSLParameters params = s.getSSLParameters(); params.setEndpointIdentificationAlgorithm("HTTPS"); s.setSSLParameters(params);
            s.startHandshake();
            byte[] nonce = new byte[16]; RNG.nextBytes(nonce);
            String challenge = Base64.getEncoder().encodeToString(nonce);
            String request = "GET /phone-remote/ws HTTP/1.1\r\nHost: " + host
                    + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + challenge
                    + "\r\nSec-WebSocket-Version: 13\r\ntuna-skip-browser-warning: 1\r\nX-Phone-Remote-Tunnel: " + key + "\r\n\r\n";
            s.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII)); s.getOutputStream().flush();
            verifyUpgrade(s.getInputStream(), challenge);
            s.setSoTimeout(120000); // server sends ping every 30 s, including during quiet chats
            return s;
        } catch (IOException | RuntimeException e) { untrack(s); throw e; }
    }
    static void verifyUpgrade(InputStream in, String challenge) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int state = 0;
        byte[] end = new byte[]{13, 10, 13, 10};
        while (state < 4) {
            int c = in.read(); if (c < 0) throw new EOFException("TUNA closed during upgrade");
            if (bytes.size() >= 16384) throw new IOException("TUNA response headers too large");
            bytes.write(c); state = c == end[state] ? state + 1 : c == 13 ? 1 : 0;
        }
        String[] lines = new String(bytes.toByteArray(), StandardCharsets.US_ASCII).split("\r\n");
        if (!lines[0].matches("HTTP/1\\.[01] 101(?: .*)?")) throw new IOException("TUNA: " + lines[0]);
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':'); if (colon < 1) throw new IOException("Malformed upgrade header");
            String name = lines[i].substring(0, colon).toLowerCase(Locale.ROOT);
            if (headers.containsKey(name)) throw new IOException("Duplicate upgrade header");
            headers.put(name, lines[i].substring(colon + 1).trim());
        }
        try {
            String expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((challenge + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
            boolean connection = false;
            for (String part : headers.getOrDefault("connection", "").split(",")) connection |= part.trim().equalsIgnoreCase("upgrade");
            if (!connection || !"websocket".equalsIgnoreCase(headers.get("upgrade")) || !expected.equals(headers.get("sec-websocket-accept"))
                    || headers.containsKey("sec-websocket-extensions") || headers.containsKey("sec-websocket-protocol")) throw new IOException("Invalid TUNA WebSocket upgrade");
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }
    static void writeFrame(OutputStream out, int opcode, byte[] data, int offset, int length) throws IOException {
        if (length > MAX_FRAME) throw new IOException("Frame too large");
        out.write(0x80 | opcode);
        if (length < 126) out.write(0x80 | length);
        else if (length <= 65535) { out.write(0xfe); out.write(length >>> 8); out.write(length); }
        else { out.write(0xff); for (int i = 7; i >= 0; i--) out.write((int)((long)length >>> (i * 8))); }
        byte[] mask = new byte[4]; RNG.nextBytes(mask); out.write(mask);
        byte[] chunk = new byte[length];
        for (int i = 0; i < length; i++) chunk[i] = (byte)(data[offset + i] ^ mask[i & 3]);
        out.write(chunk); out.flush();
    }
    static void readFrames(InputStream in, OutputStream wsOut, OutputStream appOut) throws IOException {
        boolean fragmented = false; int messageSize = 0;
        while (true) {
            int first = in.read(); if (first < 0) { if (fragmented) throw new EOFException(); return; }
            int second = readByte(in); boolean fin = (first & 0x80) != 0;
            int opcode = first & 15; long length = second & 127;
            if ((first & 0x70) != 0 || (second & 0x80) != 0) throw new IOException("Invalid WebSocket flags");
            if (length == 126) { length = (readByte(in) << 8) | readByte(in); if (length < 126) throw new IOException("Noncanonical frame length"); }
            else if (length == 127) {
                length = 0;
                for (int i = 0; i < 8; i++) { int b = readByte(in); if (i == 0 && (b & 128) != 0) throw new IOException("Invalid length"); length = (length << 8) | b; }
                if (length <= 65535) throw new IOException("Noncanonical frame length");
            }
            if (length > MAX_FRAME) throw new IOException("Frame too large");
            boolean control = opcode >= 8;
            if (control && (!fin || length > 125 || opcode != 8 && opcode != 9 && opcode != 10)) throw new IOException("Invalid control frame");
            if (!control) {
                if (opcode == 2 && fragmented || opcode == 0 && !fragmented || opcode != 0 && opcode != 2) throw new IOException("Invalid binary fragmentation");
                if (opcode == 2) messageSize = 0;
                messageSize += (int)length; if (messageSize > MAX_FRAME) throw new IOException("Message too large");
                fragmented = !fin;
            }
            byte[] payload = new byte[(int)length]; readFully(in, payload);
            if (opcode == 8) { if (length == 1) throw new IOException("Invalid close frame"); return; }
            if (opcode == 9) { synchronized (wsOut) { writeFrame(wsOut, 10, payload, 0, payload.length); } }
            else if (opcode != 10) { appOut.write(payload); appOut.flush(); }
        }
    }
    private static int readByte(InputStream in) throws IOException { int c = in.read(); if (c < 0) throw new EOFException(); return c; }
    private static void readFully(InputStream in, byte[] data) throws IOException { int at = 0; while (at < data.length) { int n = in.read(data, at, data.length - at); if (n < 0) throw new EOFException(); at += n; } }
    private static void closeSocket(Socket s) { try { s.close(); } catch (IOException ignored) {} }
}
