package tech.taill.astraremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Where the pairing lives: the PC's addresses, port, certificate fingerprint and this phone's key.
 * Encrypted with an AES key that never leaves the Android Keystore, so the file on its own is useless.
 */
final class Vault {
    private static final String ALIAS = "astra-remote-vault";
    private static final String PREFS = "vault";

    static final class Pairing {
        String[] hosts;
        int port;
        String fingerprint; // lowercase hex SHA-256 of the PC's certificate
        String token;
        String pcName;
        String lastHost = "";
        String relayUrl = ""; // wss://… — the relay, if the PC uses one
        String relayId = "";  // this PC's id on it

        JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("hosts", String.join(",", hosts));
            o.put("port", port);
            o.put("fp", fingerprint);
            o.put("token", token);
            o.put("pc", pcName);
            o.put("last", lastHost);
            o.put("ru", relayUrl);
            o.put("ri", relayId);
            return o;
        }

        static Pairing fromJson(JSONObject o) {
            Pairing p = new Pairing();
            p.hosts = o.optString("hosts").split(",");
            p.port = o.optInt("port");
            p.fingerprint = o.optString("fp");
            p.token = o.optString("token");
            p.pcName = o.optString("pc");
            p.lastHost = o.optString("last");
            p.relayUrl = o.optString("ru");
            p.relayId = o.optString("ri");
            return p;
        }
    }

    private final SharedPreferences prefs;

    Vault(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    synchronized Pairing load() {
        String blob = prefs.getString("pairing", null);
        if (blob == null) return null;
        try {
            byte[] all = Base64.decode(blob, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            byte[] plain = c.doFinal(all, 12, all.length - 12);
            return Pairing.fromJson(new JSONObject(new String(plain, StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return null; // the key is gone (e.g. lock screen removed): the phone has to pair again
        }
    }

    synchronized void save(Pairing p) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(p.toJson().toString().getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        prefs.edit().putString("pairing", Base64.encodeToString(all, Base64.NO_WRAP)).apply();
    }

    synchronized void clear() {
        prefs.edit().remove("pairing").apply();
    }
}
