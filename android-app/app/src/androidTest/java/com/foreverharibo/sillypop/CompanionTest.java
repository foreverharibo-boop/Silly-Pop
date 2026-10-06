package com.foreverharibo.sillypop;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the real launcher aliases and an external notification broadcast. */
@RunWith(AndroidJUnit4.class)
public final class CompanionTest {
    @Test
    public void notificationOpensOnlyAnUnambiguousMatchingWebApp() {
        Intent base = new Intent(Intent.ACTION_VIEW, Uri.parse("https://silly.example/chat"));
        ResolveInfo browser = webApp("browser", null);
        assertNull(NotificationHelper.selectWebAppIntent(base, java.util.List.of(browser)));
        ResolveInfo app = webApp("org.chromium.webapk.example", "https://silly.example/");
        Intent target = NotificationHelper.selectWebAppIntent(base, java.util.List.of(browser, app));
        assertNotNull(target);
        assertEquals("org.chromium.webapk.example", target.getComponent().getPackageName());
        assertEquals(base.getData(), target.getData());
        assertNull(NotificationHelper.selectWebAppIntent(base,
            java.util.List.of(webApp("other", "https://other.example/"))));
        assertNull(NotificationHelper.selectWebAppIntent(base,
            java.util.List.of(app, webApp("duplicate", "https://silly.example/"))));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertNull(NotificationHelper.createOpenIntent(context, "javascript:alert(1)"));
    }

    private static ResolveInfo webApp(String packageName, String startUrl) {
        ResolveInfo result = new ResolveInfo();
        result.activityInfo = new ActivityInfo();
        result.activityInfo.name = "MainActivity";
        result.activityInfo.packageName = packageName;
        result.activityInfo.enabled = true;
        result.activityInfo.exported = true;
        result.activityInfo.applicationInfo = new ApplicationInfo();
        result.activityInfo.applicationInfo.enabled = true;
        result.activityInfo.applicationInfo.metaData = new Bundle();
        if (startUrl != null) result.activityInfo.applicationInfo.metaData.putString(
            "org.chromium.webapk.shell_apk.startUrl", startUrl);
        return result;
    }

    @Test
    public void switchingIconsKeepsScreenAliveAndReceiverPostsNotification() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        String packageName = context.getPackageName();
        if (Build.VERSION.SDK_INT >= 33) {
            instrumentation.getUiAutomation().grantRuntimePermission(packageName, Manifest.permission.POST_NOTIFICATIONS);
        }
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(MainActivity.class.getName(), null, false);
        context.startActivity(new Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setComponent(new ComponentName(packageName, packageName + ".BlackIcon"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Activity screen = monitor.waitForActivityWithTimeout(10000);
        instrumentation.removeMonitor(monitor);
        assertNotNull("Launcher must open settings", screen);
        instrumentation.waitForIdleSync();

        ActivityManager manager = context.getSystemService(ActivityManager.class);
        boolean stableRoot = false;
        for (ActivityManager.AppTask task : manager.getAppTasks()) {
            ActivityManager.RecentTaskInfo info;
            try {
                info = task.getTaskInfo();
            } catch (IllegalArgumentException removedTask) {
                // The disposable launcher can finish between enumeration and lookup.
                continue;
            }
            if (info.taskId == screen.getTaskId()) {
                stableRoot = new ComponentName(context, MainActivity.class).equals(info.baseActivity);
            }
        }
        assertTrue("Settings task must not be rooted at an icon alias", stableRoot);

        int[] buttons = { R.id.whiteIconButton, R.id.blackIconButton, R.id.whiteIconButton };
        for (int button : buttons) {
            instrumentation.runOnMainSync(() -> screen.findViewById(button).performClick());
            instrumentation.waitForIdleSync();
            SystemClock.sleep(1500); // Allow asynchronous launcher/package changes to settle.
            instrumentation.runOnMainSync(() -> {
                assertFalse("Theme switch must not finish settings", screen.isFinishing());
                assertFalse("Theme switch must not destroy settings", screen.isDestroyed());
                assertTrue("Settings must remain visible", screen.hasWindowFocus());
            });
            boolean white = button == R.id.whiteIconButton;
            PackageManager pm = context.getPackageManager();
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                pm.getComponentEnabledSetting(new ComponentName(packageName, packageName + (white ? ".WhiteIcon" : ".BlackIcon"))));
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                pm.getComponentEnabledSetting(new ComponentName(packageName, packageName + (white ? ".BlackIcon" : ".WhiteIcon"))));
        }

        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        notifications.cancelAll();
        try (ParcelFileDescriptor output = instrumentation.getUiAutomation().executeShellCommand(
                "am broadcast --receiver-foreground --include-stopped-packages -n " + packageName
                + "/.SillyPopReceiver -a " + SillyPopReceiver.ACTION_NOTIFY
                + " --es title CompanionRegression --es body DeliveryTest --ez sound false --ez vibrate false")) {
            try (ParcelFileDescriptor.AutoCloseInputStream stream = new ParcelFileDescriptor.AutoCloseInputStream(output)) {
                byte[] buffer = new byte[1024];
                while (stream.read(buffer) != -1) { /* Wait for the external command to finish. */ }
            }
        }
        boolean received = false;
        for (int attempt = 0; attempt < 30 && !received; attempt++) {
            for (StatusBarNotification posted : notifications.getActiveNotifications()) {
                if ("CompanionRegression".contentEquals(
                    posted.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE, ""))) {
                    received = true;
                    assertNull("No installed localhost WebAPK: notification must not open a browser",
                        posted.getNotification().contentIntent);
                }
            }
            if (!received) SystemClock.sleep(100);
        }
        assertTrue("External broadcast must post a system notification after icon switches", received);
        notifications.cancelAll();
        instrumentation.runOnMainSync(screen::finish);
    }
}
