package tech.taill.astraremote;

import android.os.Handler;
import android.os.Looper;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.widget.Toast;

/**
 * A quick settings tile that sends one request to the PC. Each tile is a subclass ({@link MediaTile},
 * {@link LockTile}) naming its request; the outcome shows as a toast.
 */
abstract class ActionTile extends TileService {
    abstract String path();

    abstract String body();

    abstract String done();

    @Override
    public void onStartListening() {
        Tile t = getQsTile();
        if (t == null) return;
        t.setState(new Vault(this).load() == null ? Tile.STATE_UNAVAILABLE : Tile.STATE_INACTIVE);
        t.updateTile();
    }

    @Override
    public void onClick() {
        final Handler ui = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            String msg;
            try {
                Pinned.Response r = Remote.call(this, "POST", path(), body());
                msg = r.status == 200 ? done() : Remote.error(r);
            } catch (Exception e) {
                msg = Bridge.message(e);
            }
            final String m = msg;
            ui.post(() -> Toast.makeText(this, m, Toast.LENGTH_SHORT).show());
        }, "tile").start();
    }
}
