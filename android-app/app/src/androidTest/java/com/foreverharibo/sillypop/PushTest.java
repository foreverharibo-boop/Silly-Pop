package com.foreverharibo.sillypop;
import static org.junit.Assert.*;
import android.Manifest;
import android.content.Context;
import android.app.Notification;
import android.app.NotificationManager;
import android.os.Build;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class PushTest {
    @Test public void remoteMessagesAreOptInDeduplicatedAndNeverOngoing() {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        if (Build.VERSION.SDK_INT >= 33) instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), Manifest.permission.POST_NOTIFICATIONS);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.cancelAll();
        context.getSharedPreferences("silly_pop_push_seen",0).edit().clear().commit();
        context.getSharedPreferences("silly_pop_remote",0).edit().putBoolean("enabled",false).commit();
        Map<String,String> data = Map.of("kind","reply","requestId","push-test","sound","0","vibrate","0","title","Untrusted text");
        try {
            PushService.display(context,data);
            assertEquals(0,manager.getActiveNotifications().length);
            context.getSharedPreferences("silly_pop_remote",0).edit().putBoolean("enabled",true).commit();
            PushService.display(context,data);
            assertEquals(1,manager.getActiveNotifications().length);
            Notification posted = manager.getActiveNotifications()[0].getNotification();
            assertEquals("답장이 도착했어요",posted.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
            assertEquals("silly_pop_silent",posted.getChannelId());
            assertEquals(0,posted.flags & (Notification.FLAG_ONGOING_EVENT | Notification.FLAG_FOREGROUND_SERVICE));
            assertNotNull(posted.contentIntent);
            PushService.display(context,data);
            assertEquals(1,manager.getActiveNotifications().length);
            PushService.display(context,Map.of("kind","unknown","requestId","other"));
            assertEquals(1,manager.getActiveNotifications().length);
        } finally {
            manager.cancelAll();
            context.getSharedPreferences("silly_pop_remote",0).edit().clear().commit();
            context.getSharedPreferences("silly_pop_push_seen",0).edit().clear().commit();
        }
    }
}
