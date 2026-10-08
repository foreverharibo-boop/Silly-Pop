package com.foreverharibo.sillypop;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import android.content.SharedPreferences;
import java.util.Map;

public final class PushService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) { PushSyncWorker.schedule(this); }
    @Override public void onMessageReceived(RemoteMessage message) {
        display(this, message.getData());
    }
    static void display(android.content.Context context, Map<String, String> data) {
        if (!RemotePush.enabled(context)) return;
        String kind = data.get("kind");
        String id = data.get("requestId");
        if (!("reply".equals(kind) || "test".equals(kind)) || id == null || !id.matches("[a-zA-Z0-9_-]{1,100}")) return;
        SharedPreferences recent = context.getSharedPreferences("silly_pop_push_seen", MODE_PRIVATE);
        synchronized (PushService.class) {
            if (recent.contains(id)) return;
            SharedPreferences.Editor edit = recent.edit();
            long now = System.currentTimeMillis();
            for (Map.Entry<String, ?> entry : recent.getAll().entrySet()) {
                if (!(entry.getValue() instanceof Long) || now - (Long)entry.getValue() > 86400000L) edit.remove(entry.getKey());
            }
            edit.putLong(id, now).commit();
        }
        String url = context.getSharedPreferences(NotificationHelper.PREFERENCES, MODE_PRIVATE)
            .getString(NotificationHelper.KEY_LAST_URL, "");
        NotificationHelper.showRemote(context, "test".equals(kind) ? "Silly-Pop PC 테스트" : "답장이 도착했어요",
            url, !"0".equals(data.get("sound")), !"0".equals(data.get("vibrate")));
    }
}
