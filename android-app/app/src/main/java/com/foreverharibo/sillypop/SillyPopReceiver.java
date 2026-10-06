package com.foreverharibo.sillypop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

public final class SillyPopReceiver extends BroadcastReceiver {
    public static final String ACTION_NOTIFY = "com.foreverharibo.sillypop.NOTIFY";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_NOTIFY.equals(intent.getAction())) return;

        String title = clean(intent.getStringExtra("title"), 120);
        String body = clean(intent.getStringExtra("body"), 280);
        String url = safeUrl(intent.getStringExtra("url"));
        boolean sound = intent.getBooleanExtra("sound", true);
        boolean vibrate = intent.getBooleanExtra("vibrate", true);

        if (title.isEmpty()) title = "Silly-Pop";
        if (body.isEmpty()) body = "답변이 도착했어요. 눌러서 확인하세요 ✨";
        if (url.isEmpty()) url = NotificationHelper.DEFAULT_SILLY_URL;

        context.getSharedPreferences(NotificationHelper.PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(NotificationHelper.KEY_LAST_URL, url)
            .apply();

        NotificationHelper.show(context, title, body, url, sound, vibrate);
        setResultCode(ActivityResultCodes.OK);
    }

    private static String clean(String value, int maxLength) {
        if (value == null) return "";
        String cleaned = value.replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", " ")
            .replaceAll("\\s+", " ")
            .trim();
        return cleaned.length() > maxLength ? cleaned.substring(0, maxLength) : cleaned;
    }

    private static String safeUrl(String value) {
        if (value == null) return "";
        try {
            Uri uri = Uri.parse(value.trim());
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return "";
            return uri.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static final class ActivityResultCodes {
        private static final int OK = -1;
    }
}
