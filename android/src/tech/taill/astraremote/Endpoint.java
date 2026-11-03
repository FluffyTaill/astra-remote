package tech.taill.astraremote;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Local routes only. Internet is a distinct TUNA byte tunnel, never a direct HTTPS origin. */
final class Endpoint {
    static String normalize(String value) {
        if (value == null || value.length() > 300) return null;
        String s = value.trim();
        if (localIp(s)) return s;
        if (!s.startsWith("https://") || s.matches(".*[\\s\\\\?#@,].*")) return null;
        try {
            URI u = new URI(s);
            if (!localIp(u.getHost()) || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null
                    || !(u.getRawPath().isEmpty() || "/".equals(u.getRawPath())) || u.getPort() < -1 || u.getPort() == 0 || u.getPort() > 65535) return null;
            return "https://" + u.getHost() + (u.getPort() < 0 || u.getPort() == 443 ? "" : ":" + u.getPort());
        } catch (Exception ignored) { return null; }
    }
    static boolean localIp(String s) {
        if (s == null || !s.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return false;
        String[] parts = s.split("\\.");
        int[] p = new int[4];
        for (int i = 0; i < 4; i++) {
            if (parts[i].length() > 1 && parts[i].startsWith("0")) return false;
            p[i] = Integer.parseInt(parts[i]); if (p[i] > 255) return false;
        }
        return p[0] == 10 || p[0] == 127 || p[0] == 172 && p[1] >= 16 && p[1] <= 31 || p[0] == 192 && p[1] == 168 || p[0] == 169 && p[1] == 254;
    }
    static String tuna(String value) {
        if (value == null || value.length() > 300) return null;
        String s = value.trim();
        if (!s.startsWith("https://") || s.matches(".*[\\s\\\\?#@].*")) return null;
        try {
            URI u = new URI(s);
            String host = u.getHost();
            if (host == null || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null
                    || !(u.getRawPath().isEmpty() || "/".equals(u.getRawPath())) || u.getPort() != -1 && u.getPort() != 443) return null;
            host = host.toLowerCase(Locale.ROOT);
            if (!host.matches("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:tuna\\.am|tuna\\.free)")) return null;
            return "https://" + host;
        } catch (Exception ignored) { return null; }
    }
    static List<String> valid(Iterable<String> list) {
        List<String> out = new ArrayList<>(); int count = 0;
        for (String s : list) {
            if (++count > 16) break;
            String n = normalize(s);
            if (n != null && !out.contains(n)) out.add(n);
            if (out.size() == 6) break;
        }
        return out;
    }
    static String origin(String endpoint, int legacyPort) {
        String n = normalize(endpoint);
        if (n == null) throw new IllegalArgumentException("Некорректный домашний адрес ПК");
        return n.startsWith("https://") ? n : "https://" + n + ":" + legacyPort;
    }
}
