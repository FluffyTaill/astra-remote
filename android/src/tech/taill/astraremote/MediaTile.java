package tech.taill.astraremote;

/** Play/pause on the PC from the quick settings shade. */
public final class MediaTile extends ActionTile {
    @Override String path() { return "/api/media"; }

    @Override String body() { return "{\"key\":\"play_pause\"}"; }

    @Override String done() { return "Пауза / продолжить на ПК"; }
}
