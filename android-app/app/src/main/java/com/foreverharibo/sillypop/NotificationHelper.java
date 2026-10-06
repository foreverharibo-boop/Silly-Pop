package com.foreverharibo.sillypop;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Browser;

import java.util.concurrent.atomic.AtomicInteger;

public final class NotificationHelper {
    public static final String PREFERENCES = "silly_pop_settings";
    public static final String KEY_LAST_URL = "last_silly_url";
    public static final String DEFAULT_SILLY_URL = "http://127.0.0.1:8000/";

    private static final String CHANNEL_LOUD = "silly_pop_loud";
    private static final String CHANNEL_SOUND = "silly_pop_sound";
    private static final String CHANNEL_VIBRATE = "silly_pop_vibrate";
    private static final String CHANNEL_SILENT = "silly_pop_silent";
    private static final String SAMSUNG_INTERNET = "com.sec.android.app.sbrowser";
    private static final AtomicInteger NEXT_ID = new AtomicInteger(1200);
    private static final long[] VIBRATION = new long[]{0, 140, 70, 140};

    private NotificationHelper() {}

    public static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        manager.createNotificationChannel(makeChannel(CHANNEL_LOUD, "답변 알림 · 소리와 진동", true, true));
        manager.createNotificationChannel(makeChannel(CHANNEL_SOUND, "답변 알림 · 소리", true, false));
        manager.createNotificationChannel(makeChannel(CHANNEL_VIBRATE, "답변 알림 · 진동", false, true));
        manager.createNotificationChannel(makeChannel(CHANNEL_SILENT, "답변 알림 · 무음", false, false));
    }

    private static NotificationChannel makeChannel(String id, String name, boolean sound, boolean vibrate) {
        NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("SillyTavern 답변 생성 완료 알림");
        channel.enableVibration(vibrate);
        channel.setVibrationPattern(vibrate ? VIBRATION : null);

        if (sound) {
            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            channel.setSound(soundUri, attributes);
        } else {
            channel.setSound(null, null);
        }
        return channel;
    }

    public static boolean canNotify(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return true;
    }

    public static boolean show(Context context, String title, String body, String url, boolean sound, boolean vibrate) {
        createChannels(context);
        if (!canNotify(context)) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);

        String channelId = channelId(sound, vibrate);
        NotificationChannel channel = manager.getNotificationChannel(channelId);
        if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        PendingIntent openIntent = PendingIntent.getActivity(
            context,
            NEXT_ID.incrementAndGet(),
            createOpenIntent(context, url),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setShowWhen(true)
            .build();

        try {
            manager.notify(NEXT_ID.incrementAndGet(), notification);
            return true;
        } catch (SecurityException error) {
            return false;
        }
    }

    public static Intent createOpenIntent(Context context, String url) {
        Uri uri;
        try {
            uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                uri = Uri.parse(DEFAULT_SILLY_URL);
            }
        } catch (Exception ignored) {
            uri = Uri.parse(DEFAULT_SILLY_URL);
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            .putExtra(Browser.EXTRA_APPLICATION_ID, SAMSUNG_INTERNET);

        PackageManager packageManager = context.getPackageManager();
        try {
            packageManager.getPackageInfo(SAMSUNG_INTERNET, 0);
            intent.setPackage(SAMSUNG_INTERNET);
        } catch (PackageManager.NameNotFoundException ignored) {
            // Use the user's default browser when Samsung Internet is not installed.
        }
        return intent;
    }

    private static String channelId(boolean sound, boolean vibrate) {
        if (sound && vibrate) return CHANNEL_LOUD;
        if (sound) return CHANNEL_SOUND;
        if (vibrate) return CHANNEL_VIBRATE;
        return CHANNEL_SILENT;
    }
}
