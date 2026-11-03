package tech.taill.astraremote;
/** Used only with generated throwaway transport/PC keys by tuna-live.cjs. */
public final class TunaPinnedProbe {
    public static void main(String[] args) throws Exception {
        TunaTunnel tunnel = new TunaTunnel(args[0], args[1]);
        try {
            Pinned p = new Pinned(new String[0], 8765, args[2], "", tunnel);
            Pinned.Response r;
            try { r = p.request("GET", "/", "test-only-token", null, 15000); }
            catch (java.io.IOException e) {
                if (String.valueOf(e.getMessage()).contains(Pinned.MISMATCH)) System.out.println("PIN_MISMATCH_BEFORE_AUTH");
                throw e;
            }
            if (r.status != 200 || r.body.length != 3 * 1024 * 1024) throw new AssertionError("unexpected data");
            System.out.println("PASS: actual Java TunaTunnel + nested Pinned TLS + 3 MiB response");
        } finally { tunnel.close(); }
    }
}
