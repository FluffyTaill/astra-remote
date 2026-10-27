package tech.taill.astraremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;

/**
 * The PC from outside the app's screen — the widget, the quick settings tiles, the notes job: one
 * request with the pairing from {@link Vault}, over {@link Pinned} (and the relay when the PC has one),
 * exactly as the app itself would make it. Also the notes Astra sends to the phone.
 */
final class Remote {
    static final String PREFS = "remote";

    private Remote() {
    }

    static Pinned.Response call(Context ctx, String method, String path, String json) throws IOException {
        Vault.Pairing p = new Vault(ctx).load();
        if (p == null) throw new IOException("Телефон не подключён к ПК: открой Phone Remote");
        Relay r = Relay.valid(p.relayUrl, p.relayId) ? new Relay(p.relayUrl, p.relayId) : null;
        try {
            return new Pinned(p.hosts, p.port, p.fingerprint, p.lastHost, r).request(method, path, p.token, json, 20000);
        } finally {
            if (r != null) r.close();
        }
    }

    static String error(Pinned.Response r) {
        try {
            return new JSONObject(r.text()).optString("error", "Ошибка " + r.status);
        } catch (Exception e) {
            return "Ошибка " + r.status;
        }
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── notes from Astra ────────────────────────────────────────────────────

    private static final String CHANNEL = "astra";
    private static final int JOB = 41;

    static boolean notesOn(Context ctx) {
        return prefs(ctx).getBoolean("notes", true);
    }

    /** Fetch the notes newer than the last one shown and show each; returns how many. */
    static synchronized int checkNotes(Context ctx) throws Exception {
        SharedPreferences sp = prefs(ctx);
        long since = sp.getLong("lastNote", -1);
        Pinned.Response r = call(ctx, "GET", "/api/notes?since=" + Math.max(0, since), null);
        if (r.status != 200) throw new IOException(error(r));
        JSONArray list = new JSONObject(r.text()).optJSONArray("notes");
        if (list == null || list.length() == 0) return 0;
        long newest = since;
        int shown = 0;
        // the first check after pairing only remembers where the list is: old notes are not news
        boolean first = since < 0;
        for (int i = list.length() - 1; i >= 0; i--) {
            JSONObject n = list.getJSONObject(i);
            long id = n.optLong("id");
            newest = Math.max(newest, id);
            if (!first) {
                show(ctx, (int) id, n.optString("title", "Astra"), n.optString("text"));
                shown++;
            }
        }
        sp.edit().putLong("lastNote", newest).apply();
        return shown;
    }

    static void show(Context ctx, int id, String title, String text) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Сообщения от Astra", NotificationManager.IMPORTANCE_HIGH));
        }
        PendingIntent open = PendingIntent.getActivity(ctx, 0, new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_tile_play)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build();
        try {
            nm.notify(1000 + id, n);
        } catch (SecurityException ignored) {
            // notifications are not allowed for the app
        }
    }

    /** About every 15 minutes, when there is a network, while notes are on. */
    static void scheduleNotes(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null) return;
        if (!notesOn(ctx) || new Vault(ctx).load() == null) {
            js.cancel(JOB);
            return;
        }
        if (js.getPendingJob(JOB) != null) return;
        try {
            js.schedule(new JobInfo.Builder(JOB, new ComponentName(ctx, NotesJob.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(15 * 60 * 1000L)
                    .build());
        } catch (RuntimeException ignored) {
            // a phone that refuses background jobs: notes still come while the app is open
        }
    }
}
