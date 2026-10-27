package tech.taill.astraremote;

import android.content.Context;

/** The app's own version, for the crash report. */
final class BuildInfo {
    private BuildInfo() {
    }

    static String version(Context ctx) {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}
