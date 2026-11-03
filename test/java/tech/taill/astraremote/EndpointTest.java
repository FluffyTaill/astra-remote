package tech.taill.astraremote;
import java.util.Arrays;
public final class EndpointTest {
    private static void eq(String a, String b) { if (!java.util.Objects.equals(a, b)) throw new AssertionError(a + " != " + b); }
    public static void main(String[] args) {
        eq(Endpoint.normalize("192.168.1.2"), "192.168.1.2");
        eq(Endpoint.origin("192.168.1.2", 8765), "https://192.168.1.2:8765");
        eq(Endpoint.normalize("https://10.1.2.3:9443/"), "https://10.1.2.3:9443");
        for (String value : new String[]{"https://pc.example.ru", "8.8.8.8", "100.64.0.1", "https://8.8.8.8:9443", "https://[2606:4700::1111]", "192.168.001.1"}) eq(Endpoint.normalize(value), null);
        if (Endpoint.valid(Arrays.asList("192.168.1.2", "192.168.1.2", "https://pc.example.ru:9443")).size() != 1) throw new AssertionError("migration removes old public routes");
        for (String s : new String[]{"https://test.ru.tuna.am", "https://test.a.tuna.free"}) eq(Endpoint.tuna(s), s);
        eq(Endpoint.tuna("https://test.tuna.am:443/"), "https://test.tuna.am");
        for (String s : new String[]{"https://tuna.am", "https://tuna.free", "https://test.tuna.am.attacker.ru", "https://user@test.tuna.am", "http://test.tuna.am", "https://test.tuna.am:444", "https://test.tuna.am/path", "https://test.tuna.am?", "https://test.tuna.am#"}) eq(Endpoint.tuna(s), null);
        System.out.println("LAN migration and TUNA URL tests passed");
    }
}
