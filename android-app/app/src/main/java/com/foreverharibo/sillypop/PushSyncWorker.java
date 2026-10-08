package com.foreverharibo.sillypop;
import android.content.Context;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.WorkManager;
import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.ExistingWorkPolicy;
import androidx.work.BackoffPolicy;
import java.util.concurrent.TimeUnit;

// One-off token sync, never a permanent connection or foreground service.
public final class PushSyncWorker extends Worker {
    public PushSyncWorker(Context context, WorkerParameters parameters) { super(context, parameters); }
    static void schedule(Context context) {
        if (!BuildConfig.PUSH_CONFIGURED || !RemotePush.enabled(context)) return;
        WorkManager.getInstance(context).enqueueUniqueWork("silly-pop-token", ExistingWorkPolicy.KEEP,
            new OneTimeWorkRequest.Builder(PushSyncWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }
    static void cancel(Context context) { WorkManager.getInstance(context).cancelUniqueWork("silly-pop-token"); }
    @Override public Result doWork() {
        try { RemotePush.sync(getApplicationContext()); return Result.success(); }
        catch (Exception ignored) { return Result.retry(); }
    }
}
