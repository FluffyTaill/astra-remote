package tech.taill.astraremote;

/** Lock the PC from the quick settings shade. */
public final class LockTile extends ActionTile {
    @Override String path() { return "/api/power"; }

    @Override String body() { return "{\"action\":\"lock\"}"; }

    @Override String done() { return "ПК заблокирован"; }
}
