package tech.taill.astraremote;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.widget.RemoteViews;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The home-screen widget: the first four labelled buttons of the remote. A tap runs the Astra command
 * hung on that button, as the button in the app does. The labels are those the app last saw on the PC.
 */
public final class ButtonsWidget extends AppWidgetProvider {
    private static final String PRESS = "tech.taill.astraremote.PRESS";
    private static final int[] IDS = {R.id.b1, R.id.b2, R.id.b3, R.id.b4};

    /** The app saw the PC's buttons: remember the first four and redraw the widgets. */
    static void saveButtons(Context ctx, JSONArray buttons) {
        try {
            JSONArray keep = new JSONArray();
            for (int i = 0; i < buttons.length() && keep.length() < IDS.length; i++) {
                JSONObject b = buttons.getJSONObject(i);
                if (b.optString("label").isEmpty()) continue;
                keep.put(new JSONObject().put("n", b.optInt("n")).put("label", b.optString("label")).put("icon", b.optString("icon")));
            }
            SharedPreferences sp = Remote.prefs(ctx);
            if (keep.toString().equals(sp.getString("widget", ""))) return;
            sp.edit().putString("widget", keep.toString()).apply();
            redraw(ctx);
        } catch (Exception ignored) {
        }
    }

    static void redraw(Context ctx) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        int[] ids = m.getAppWidgetIds(new ComponentName(ctx, ButtonsWidget.class));
        if (ids.length > 0) new ButtonsWidget().onUpdate(ctx, m, ids);
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] widgetIds) {
        JSONArray list;
        try {
            list = new JSONArray(Remote.prefs(ctx).getString("widget", "[]"));
        } catch (Exception e) {
            list = new JSONArray();
        }
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_buttons);
        for (int i = 0; i < IDS.length; i++) {
            JSONObject b = list.optJSONObject(i);
            if (b == null) {
                v.setTextViewText(IDS[i], i == 0 && list.length() == 0 ? "Открой Phone Remote" : "");
                v.setOnClickPendingIntent(IDS[i], PendingIntent.getActivity(ctx, 100 + i, new Intent(ctx, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
                continue;
            }
            String icon = b.optString("icon");
            v.setTextViewText(IDS[i], (icon.isEmpty() ? "" : icon + "\n") + b.optString("label"));
            Intent press = new Intent(ctx, ButtonsWidget.class).setAction(PRESS).putExtra("n", b.optInt("n")).putExtra("label", b.optString("label"));
            v.setOnClickPendingIntent(IDS[i], PendingIntent.getBroadcast(ctx, i, press, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        m.updateAppWidget(widgetIds, v);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!PRESS.equals(intent.getAction())) {
            super.onReceive(ctx, intent);
            return;
        }
        final int n = intent.getIntExtra("n", 0);
        final String label = intent.getStringExtra("label");
        final Context app = ctx.getApplicationContext();
        final PendingResult done = goAsync();
        final Handler ui = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            String msg;
            try {
                Pinned.Response r = Remote.call(app, "POST", "/api/button", "{\"n\":" + n + "}");
                msg = r.status == 200 ? "«" + label + "» — готово" : Remote.error(r);
            } catch (Exception e) {
                msg = Bridge.message(e);
            }
            final String m = msg;
            ui.post(() -> Toast.makeText(app, m, Toast.LENGTH_SHORT).show());
            done.finish();
        }, "widget").start();
    }
}
