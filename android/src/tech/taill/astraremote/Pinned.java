package tech.taill.astraremote;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * HTTPS to the paired PC, trusting exactly one certificate: the one whose SHA-256 came in the QR code.
 * Nobody else on the network can stand in for the PC — not even with a certificate a public CA signed.
 * The host name is not checked because the PC is reached by IP; the pin is the whole of the check.
 * Nothing (no key, no body) is written before the handshake has passed the pin.
 */
final class Pinned {
    static final class Response {
        final int status;
        final byte[] body;

        Response(int status, byte[] body) {
            this.status = status;
            this.body = body;
        }

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    /** Writes a request body once the connection is up. */
    interface Body {
        void writeTo(OutputStream out) throws IOException;
    }

    static final String MISMATCH = "Сертификат не совпадает с ПК, к которому подключён телефон";

    private final String[] hosts;
    private final int port;
    private final Relay relay; // null: home network and Tailscale only
    private final SSLSocketFactory factory;
    private volatile String current;

    Pinned(String[] hosts, int port, final String fingerprint, String lastHost, Relay relay) {
        this.hosts = hosts;
        this.port = port;
        this.relay = relay;
        this.current = lastHost != null && !lastHost.isEmpty() && (relay != null || !Relay.HOST.equals(lastHost)) ? lastHost : hosts[0];
        final byte[] pin = fingerprint.toLowerCase().getBytes(StandardCharsets.US_ASCII);
        try {
            TrustManager tm = new X509TrustManager() {
                @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    throw new CertificateException("not a server");
                }

                @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
                    try {
                        byte[] d = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                        if (!MessageDigest.isEqual(hex(d).getBytes(StandardCharsets.US_ASCII), pin)) {
                            throw new CertificateException(MISMATCH);
                        }
                    } catch (CertificateException e) {
                        throw e;
                    } catch (Exception e) {
                        throw new CertificateException(e);
                    }
                }

                @Override public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{tm}, null);
            factory = ctx.getSocketFactory();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    String currentHost() {
        return current;
    }

    private HttpsURLConnection open(String host, String method, String path, String token, int readTimeoutMs) throws IOException {
        // the relay is a port of this app on 127.0.0.1 that leads to the PC (see Relay); the TLS is still the PC's
        String where = Relay.HOST.equals(host) ? "127.0.0.1:" + relay.port() : host + ":" + port;
        HttpsURLConnection c = (HttpsURLConnection) new URL("https://" + where + path).openConnection();
        c.setSSLSocketFactory(factory);
        c.setHostnameVerifier((h, s) -> true); // see the class comment: the certificate pin is the check
        c.setRequestMethod(method);
        c.setConnectTimeout(3000);
        c.setReadTimeout(readTimeoutMs);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    /**
     * Open a connection, trying the last working address first and then the others. The handshake runs
     * on its own first (connect()), so a body and the key go out only to the pinned PC. An address that
     * answers with another certificate is skipped — at a friend's place 192.168.1.5 is someone else —
     * and reported only if no address worked.
     */
    HttpsURLConnection connect(String method, String path, String token, String contentType, long length, Body body, int readTimeoutMs) throws IOException {
        IOException last = null;
        boolean mismatch = false;
        List<String> order = new ArrayList<>();
        order.add(current);
        for (String h : hosts) if (!h.equals(current)) order.add(h);
        if (relay != null && !order.contains(Relay.HOST)) order.add(Relay.HOST); // from anywhere, last unless it worked last time
        for (String host : order) {
            HttpsURLConnection c = open(host, method, path, token, readTimeoutMs);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", contentType);
                if (length >= 0) c.setFixedLengthStreamingMode(length);
                else c.setChunkedStreamingMode(64 * 1024);
            }
            try {
                c.connect();
            } catch (SSLException e) {
                if (String.valueOf(e.getMessage()).contains(MISMATCH) || e.getCause() instanceof CertificateException) mismatch = true;
                last = e;
                continue;
            } catch (IOException e) {
                last = e;
                continue;
            }
            current = host;
            if (body != null) {
                try (OutputStream o = c.getOutputStream()) {
                    body.writeTo(o);
                }
            }
            c.getResponseCode();
            return c;
        }
        if (mismatch) throw new IOException(MISMATCH);
        if (relay != null && relay.offline) throw new IOException(Relay.OFFLINE);
        throw last != null ? last : new IOException("no address");
    }

    HttpsURLConnection connect(String method, String path, String token, byte[] json, int readTimeoutMs) throws IOException {
        return connect(method, path, token, "application/json", json == null ? -1 : json.length,
                json == null ? null : out -> out.write(json), readTimeoutMs);
    }

    Response request(String method, String path, String token, String json) throws IOException {
        return request(method, path, token, json, 30000);
    }

    Response request(String method, String path, String token, String json, int readTimeoutMs) throws IOException {
        HttpsURLConnection c = connect(method, path, token, json == null ? null : json.getBytes(StandardCharsets.UTF_8), readTimeoutMs);
        try {
            // read to the end and close the stream, but no disconnect(): the connection goes back to the
            // pool for the next request — through the relay that saves a new tunnel and TLS each time
            return response(c);
        } catch (IOException e) {
            c.disconnect();
            throw e;
        }
    }

    static Response response(HttpsURLConnection c) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        return new Response(code, in == null ? new byte[0] : readAll(in));
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }
}
