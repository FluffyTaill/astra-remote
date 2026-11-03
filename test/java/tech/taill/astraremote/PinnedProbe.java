package tech.taill.astraremote;
public final class PinnedProbe {
    public static void main(String[] args) throws Exception {
        Pinned p = new Pinned(new String[]{"127.0.0.1"}, Integer.parseInt(args[0]), args[1], "", null);
        Pinned.Response r = p.request("GET", "/", "test-only-token", null, 10000);
        if (r.status != 200 || r.body.length != 3 * 1024 * 1024) throw new AssertionError("unexpected pinned response");
        System.out.println("Java pinned HTTP through WebSocket byte stream passed");
    }
}
