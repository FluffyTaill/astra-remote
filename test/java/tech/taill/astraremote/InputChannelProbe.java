package tech.taill.astraremote;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class InputChannelProbe {
    public static void main(String[] args) throws Exception {
        String endpoint = args.length > 2 && args[2].equals("origin") ? "https://127.0.0.1:" + args[0] : "127.0.0.1";
        Pinned p = new Pinned(new String[]{endpoint}, Integer.parseInt(args[0]), args[1], "", null);
        CountDownLatch ack = new CountDownLatch(1);
        AtomicReference<String> error = new AtomicReference<>();
        java.util.concurrent.atomic.AtomicBoolean succeeded = new java.util.concurrent.atomic.AtomicBoolean();
        InputChannel[] ref = new InputChannel[1];
        ref[0] = new InputChannel(p, "test-only-token", new InputChannel.Listener() {
            public void message(String json) {
                if (json.contains("\"ready\":true")) {
                    for (int i = 1; i <= 4; i++) {
                        if (!ref[0].send("{\"seq\":" + i + ",\"events\":[[\"m\",1,2]]}")) {
                            error.set("send failed"); ack.countDown();
                        }
                    }
                }
                if (json.contains("\"ack\":4")) { succeeded.set(true); ack.countDown(); }
            }
            public void ended(String message) { if (!succeeded.get()) error.compareAndSet(null, message); ack.countDown(); }
        });
        ref[0].start();
        boolean done = ack.await(12, TimeUnit.SECONDS);
        ref[0].close();
        if (!done || error.get() != null) throw new AssertionError("input channel failed: " + error.get());
        System.out.println("Java pinned input channel pipelined four frames and received cumulative ACK");
    }
}
