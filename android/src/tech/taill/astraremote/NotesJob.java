package tech.taill.astraremote;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Android's periodic check for notes from Astra while the app is closed (see Remote.scheduleNotes). */
public final class NotesJob extends JobService {
    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(() -> {
            try {
                Remote.checkNotes(this);
            } catch (Exception ignored) {
                // the PC is off or out of reach: next time
            }
            jobFinished(params, false);
        }, "notes").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
