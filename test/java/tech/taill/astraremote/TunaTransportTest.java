package tech.taill.astraremote;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public final class TunaTransportTest {
    private static final String CHALLENGE = "dGhlIHNhbXBsZSBub25jZQ==";
    private static byte[] head(String accept) { return ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII); }
    private static void bad(byte[] frame) throws Exception {
        try { TunaTunnel.readFrames(new ByteArrayInputStream(frame), new ByteArrayOutputStream(), new ByteArrayOutputStream()); throw new AssertionError("bad frame accepted"); }
        catch (IOException expected) {}
    }
    private static void closeOffCallerThread() throws Exception {
        TunaTunnel tunnel = new TunaTunnel("https://unit.tuna.am", "a".repeat(64));
        Thread caller = Thread.currentThread();
        java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Thread> closer = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        java.net.Socket socket = new java.net.Socket() {
            @Override public void close() {
                closer.set(Thread.currentThread()); calls.incrementAndGet(); closed.countDown();
            }
        };
        java.lang.reflect.Method track = TunaTunnel.class.getDeclaredMethod("track", java.net.Socket.class);
        track.setAccessible(true); track.invoke(tunnel, socket);
        tunnel.close(); tunnel.close();
        if (!closed.await(3, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("socket not closed");
        if (closer.get() == caller || calls.get() != 1) throw new AssertionError("close must be asynchronous and idempotent");
        try { tunnel.port(); throw new AssertionError("closed tunnel reopened"); } catch (IOException expected) {}
    }
    private static void handshakeBudget() throws Exception {
        TunaTunnel tunnel = new TunaTunnel("https://unit.tuna.am", "a".repeat(64));
        try {
            Pinned pinned = new Pinned(new String[]{"127.0.0.1"}, 1, "0".repeat(64), "", tunnel);
            java.lang.reflect.Method open = Pinned.class.getDeclaredMethod("open", String.class, String.class, String.class, String.class, int.class);
            open.setAccessible(true);
            javax.net.ssl.HttpsURLConnection remote = (javax.net.ssl.HttpsURLConnection) open.invoke(pinned, TunaTunnel.HOST, "GET", "/", null, 10000);
            javax.net.ssl.HttpsURLConnection lan = (javax.net.ssl.HttpsURLConnection) open.invoke(pinned, "127.0.0.1", "GET", "/", null, 10000);
            if (remote.getReadTimeout() < 30000 || lan.getReadTimeout() != 3000) throw new AssertionError("incorrect handshake budget");
        } finally { tunnel.close(); }
    }
    public static void main(String[] args) throws Exception {
        closeOffCallerThread();
        handshakeBudget();
        TunaTunnel.verifyUpgrade(new ByteArrayInputStream(head("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")), CHALLENGE);
        try { TunaTunnel.verifyUpgrade(new ByteArrayInputStream(head("wrong")), CHALLENGE); throw new AssertionError("bad WS accept"); } catch (IOException expected) {}
        try { TunaTunnel.verifyUpgrade(new ByteArrayInputStream("HTTP/1.1 101\r\n\r\n".getBytes(StandardCharsets.US_ASCII)), CHALLENGE); throw new AssertionError("missing upgrade"); } catch (IOException expected) {}
        ByteArrayOutputStream out = new ByteArrayOutputStream(), pong = new ByteArrayOutputStream();
        // Fragmented binary, ping in the middle, continuation.
        TunaTunnel.readFrames(new ByteArrayInputStream(new byte[]{2, 2, 1, 2, (byte)137, 1, 9, (byte)128, 1, 3}), pong, out);
        if (!Arrays.equals(out.toByteArray(), new byte[]{1, 2, 3}) || pong.size() != 7) throw new AssertionError("fragment/pong");
        for (byte[] frame : new byte[][]{{(byte)129,0},{(byte)194,0},{(byte)130,(byte)128,0,0,0,0},{(byte)128,0},{9,0},{(byte)139,0},{(byte)136,1,0},{(byte)130,126,0,1,0},{(byte)130,127,(byte)128,0,0,0,0,0,0,0}}) bad(frame);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream(); TunaTunnel.writeFrame(encoded, 2, new byte[]{1,2,3}, 0, 3);
        byte[] bytes = encoded.toByteArray(); if ((bytes[1] & 128) == 0 || bytes.length != 9) throw new AssertionError("client masking");
        System.out.println("WebSocket upgrade, mask, fragmentation, bounds and control validation passed");
    }
}
