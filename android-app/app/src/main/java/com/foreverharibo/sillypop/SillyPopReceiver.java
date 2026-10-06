package com.foreverharibo.sillypop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import org.json.JSONObject;

public final class SillyPopReceiver extends BroadcastReceiver {
    public static final String ACTION_NOTIFY = "com.foreverharibo.sillypop.NOTIFY";
    public static final String ACTION_PING = "com.foreverharibo.sillypop.PING";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (!ACTION_NOTIFY.equals(intent.getAction()) && !ACTION_PING.equals(intent.getAction())) return;
        JSONObject message = BridgeAuth.verify(context, intent);
        if (message == null) {
            setResultCode(ActivityResultCodes.CANCELED);
            setResultData("authentication-failed");
            return;
        }
        if (ACTION_PING.equals(intent.getAction())) {
            setResultCode(ActivityResultCodes.OK);
            setResultData("silly-pop-ready:" + BuildConfig.VERSION_NAME + ";permission="
                + (NotificationHelper.canNotify(context) ? "allowed" : "disabled"));
            return;
        }
        if (!ACTION_NOTIFY.equals(intent.getAction())) return;

        String title = clean(message.optString("title", ""), 120);
        // Older server plugins still send a body; notifications now show only the title.
        String url = safeUrl(message.optString("url", ""));
        boolean sound = message.optBoolean("sound", true);
        boolean vibrate = message.optBoolean("vibrate", true);

        if (title.isEmpty()) title = "답변이 도착했어요";
        if (url.isEmpty()) url = NotificationHelper.DEFAULT_SILLY_URL;

        context.getSharedPreferences(NotificationHelper.PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(NotificationHelper.KEY_LAST_URL, url)
            .apply();

        boolean shown = NotificationHelper.show(context, title, url, sound, vibrate);
        setResultCode(shown ? ActivityResultCodes.OK : ActivityResultCodes.CANCELED);
        setResultData(shown ? "ok" : "notification-permission-disabled");
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
        // TermuxAm propagates broadcast results to the shell exit code.
        // This is NOT an activity result: zero is success, one is failure.
        private static final int OK = 0;
        private static final int CANCELED = 1;
    }
}
