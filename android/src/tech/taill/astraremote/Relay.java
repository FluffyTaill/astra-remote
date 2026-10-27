package tech.taill.astraremote;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * The way to the PC from anywhere: the relay (a Cloudflare Worker, relay/worker.js in the plugin).
 *
 * The app keeps a port on 127.0.0.1; every connection to it becomes a WebSocket to the relay, which
 * hands it to the PC. {@link Pinned} talks HTTPS to that port exactly as it does to the PC at home, so
 * the TLS runs end to end — phone to PC, with the pinned certificate — and the relay carries bytes it
 * cannot read. The WebSocket itself is ordinary TLS to Cloudflare, checked against the system's CAs.
 */
final class Relay {
    static final String HOST = "relay"; // how the relay appears in the list of the PC's addresses
    static final String OFFLINE = "ПК сейчас не в сети: он выключен, спит или Astra на нём не запущена";

    private final String url; // wss://name.workers.dev
    private final String id;
    private ServerSocket local;
    volatile boolean offline; // the relay said the PC is not connected (last attempt)

    Relay(String url, String id) {
        this.url = url;
        this.id = id;
    }

    boolean same(String url, String id) {
        return this.url.equals(url) && this.id.equals(id);
    }

    static boolean valid(String url, String id) {
        return url != null && url.matches("^wss://[A-Za-z0-9.-]+(:\\d+)?$") && id != null && id.matches("^[a-z0-9]{16,64}$");
    }

    /** The local port to connect to; the listener starts on first use. */
    synchronized int port() throws IOException {
        if (local == null || local.isClosed()) {
            local = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(this::acceptLoop, "relay-accept");
            t.setDaemon(true);
            t.start();
        }
        return local.getLocalPort();
    }

    synchronized void close() {
        try {
            if (local != null) local.close();
        } catch (IOException ignored) {
        }
    }

    private void acceptLoop() {
        ServerSocket s = local;
        while (!s.isClosed()) {
            final Socket app;
            try {
                app = s.accept();
            } catch (IOException e) {
                return;
            }
            Thread t = new Thread(() -> tunnel(app), "relay-tunnel");
            t.setDaemon(true);
            t.start();
        }
    }

    // ── one connection: the app's socket ⇄ a WebSocket to the relay ─────────

    private void tunnel(Socket app) {
        Socket ws = null;
        try {
            ws = open();
            offline = false;
            final Socket wsF = ws;
            final InputStream wsIn = ws.getInputStream();
            final OutputStream wsOut = ws.getOutputStream();
            final OutputStream appOut = app.getOutputStream();
            // relay → app
            Thread down = new Thread(() -> {
                try {
                    readFrames(wsIn, wsOut, appOut);
                } catch (IOException ignored) {
                } finally {
                    closeQuietly(app);
                    closeQuietly(wsF);
                }
            }, "relay-down");
            down.setDaemon(true);
            down.start();
            // app → relay
            InputStream appIn = app.getInputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = appIn.read(buf)) > 0) {
                synchronized (wsOut) {
                    writeFrame(wsOut, 0x2, buf, 0, n);
                }
            }
            synchronized (wsOut) {
                writeFrame(wsOut, 0x8, new byte[]{0x03, (byte) 0xe8}, 0, 2); // close 1000
            }
        } catch (IOException ignored) {
        } finally {
            closeQuietly(app);
            closeQuietly(ws);
        }
    }

    /** TLS to the relay (system CAs, host name checked), then the WebSocket upgrade to /c/<id>. */
    private Socket open() throws IOException {
        URI u = URI.create(url);
        String host = u.getHost();
        int port = u.getPort() > 0 ? u.getPort() : 443;
        SSLSocket s = (SSLSocket) SSLSocketFactory.getDefault().createSocket();
        s.connect(new java.net.InetSocketAddress(host, port), 8000);
        s.setSoTimeout(15000);
        s.startHandshake();
        if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, s.getSession())) {
            s.close();
            throw new IOException("Сертификат ретранслятора не подошёл");
        }
        byte[] nonce = new byte[16];
        new SecureRandom().nextBytes(nonce);
        String req = "GET /c/" + id + " HTTP/1.1\r\n"
                + "Host: " + host + "\r\n"
                + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + Base64.getEncoder().encodeToString(nonce) + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n\r\n";
        OutputStream out = s.getOutputStream();
        out.write(req.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String status = readHead(s.getInputStream());
        if (!status.startsWith("HTTP/1.1 101")) {
            s.close();
            if (status.contains(" 503")) {
                offline = true;
                throw new IOException(OFFLINE);
            }
            throw new IOException("Ретранслятор ответил: " + status);
        }
        s.setSoTimeout(0); // a chat reply may be quiet for a while; TLS to the PC has its own timeouts
        return s;
    }

    /** The response head; returns its first line. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, end = 0;
        while ((c = in.read()) >= 0) {
            b.write(c);
            end = (c == '\r' || c == '\n') ? end + 1 : 0;
            if (end == 4) break;
            if (b.size() > 16384) throw new IOException("bad relay response");
        }
        if (c < 0) throw new EOFException("relay closed");
        String head = b.toString("US-ASCII");
        return head.substring(0, Math.max(0, head.indexOf('\r')));
    }

    // ── WebSocket frames (RFC 6455): the client masks what it sends ─────────

    private static final SecureRandom RNG = new SecureRandom();

    private static void writeFrame(OutputStream out, int opcode, byte[] data, int off, int len) throws IOException {
        ByteArrayOutputStream h = new ByteArrayOutputStream(14);
        h.write(0x80 | opcode);
        if (len < 126) {
            h.write(0x80 | len);
        } else if (len < 65536) {
            h.write(0x80 | 126);
            h.write(len >>> 8);
            h.write(len);
        } else {
            h.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) h.write((int) (((long) len) >>> (8 * i)));
        }
        byte[] mask = new byte[4];
        RNG.nextBytes(mask);
        h.write(mask, 0, 4);
        byte[] masked = new byte[len];
        for (int i = 0; i < len; i++) masked[i] = (byte) (data[off + i] ^ mask[i & 3]);
        out.write(h.toByteArray());
        out.write(masked);
        out.flush();
    }

    /** Payload of data frames to the app; pings answered; returns on close. */
    private static void readFrames(InputStream in, OutputStream wsOut, OutputStream appOut) throws IOException {
        while (true) {
            int b0 = in.read(), b1 = in.read();
            if (b0 < 0 || b1 < 0) return;
            int opcode = b0 & 0x0f;
            long len = b1 & 0x7f;
            if (len == 126) len = (readByte(in) << 8) | readByte(in);
            else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
            }
            byte[] mask = null;
            if ((b1 & 0x80) != 0) {
                mask = new byte[4];
                readFully(in, mask, 4);
            }
            if (len > 64L * 1024 * 1024) throw new IOException("frame too large");
            byte[] p = new byte[(int) len];
            readFully(in, p, (int) len);
            if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
            if (opcode == 0x8) return;
            if (opcode == 0x9) {
                synchronized (wsOut) {
                    writeFrame(wsOut, 0xA, p, 0, p.length);
                }
                continue;
            }
            if (opcode == 0xA) continue;
            appOut.write(p); // binary, text or a continuation: the relay passes the PC's bytes as they come
            appOut.flush();
        }
    }

    private static int readByte(InputStream in) throws IOException {
        int c = in.read();
        if (c < 0) throw new EOFException();
        return c;
    }

    private static void readFully(InputStream in, byte[] b, int len) throws IOException {
        int got = 0;
        while (got < len) {
            int n = in.read(b, got, len - got);
            if (n < 0) throw new EOFException();
            got += n;
        }
    }

    private static void closeQuietly(Socket s) {
        try {
            if (s != null) s.close();
        } catch (IOException ignored) {
        }
    }
}
